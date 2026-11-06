import {
  type MessageListener,
  type MessageTarget,
  multiplexPort,
  type PortCodec,
  type PortMux,
} from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

// Fair framing (#39, proposal 9): with `frameSize`, a large message is split
// into frames sent round-robin across ports whenever the pipe has room, so a
// small message on another port is not stuck behind it.

const KiB = 1024;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/**
 * A pipe with a narrow link: it hands the real port one message per tick and
 * reports what it holds, as a socket's write buffer would. It has room while
 * it holds less than `room` bytes.
 */
function slowPipe(port: MessagePort, room = 32 * KiB): MessageTarget {
  const queue: Uint8Array[] = [];
  let buffered = 0;
  const drained: Array<() => void> = [];
  const timer = setInterval(() => {
    const next = queue.shift();
    if (!next) return;
    buffered -= next.byteLength;
    port.postMessage(next);
    if (buffered < room) for (const resolve of drained.splice(0)) resolve();
  }, 1);
  cleanups.push(() => clearInterval(timer));
  return {
    addEventListener: (_type, listener: MessageListener) =>
      port.addEventListener("message", listener),
    removeEventListener: (_type, listener: MessageListener) =>
      port.removeEventListener("message", listener),
    start: () => port.start(),
    postMessage(message) {
      const bytes = message as Uint8Array;
      queue.push(bytes);
      buffered += bytes.byteLength;
    },
    get bufferedAmount() {
      return buffered;
    },
    whenDrained() {
      return buffered < room ? Promise.resolve() : new Promise<void>((r) => drained.push(r));
    },
  };
}

interface Arrival {
  port: string;
  data: Uint8Array;
}

function pair(
  options: { frameSize?: number; window?: number; maxReassembledBytes?: number },
  responderCodec: PortCodec = msgpackCodec,
) {
  const channel = new MessageChannel();
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const arrivals: Arrival[] = [];
  const a = multiplexPort(slowPipe(channel.port1), {
    codec: msgpackCodec,
    side: "initiator",
    window: options.window ?? 4 * 1024 * KiB,
    frameSize: options.frameSize,
  });
  const b = multiplexPort(channel.port2, {
    codec: responderCodec,
    side: "responder",
    frameSize: options.frameSize,
    maxReassembledBytes: options.maxReassembledBytes,
    onPort: (port, meta) => {
      port.addEventListener("message", (e) => {
        arrivals.push({ port: String(meta), data: e.data as Uint8Array });
      });
      return true;
    },
  });
  const muxes: PortMux[] = [a, b];
  cleanups.push(() => Promise.allSettled(muxes.map((m) => m.close())));
  return { a, b, arrivals };
}

async function acknowledged(mux: PortMux, count: number) {
  await waitFor(
    () => (mux.ports?.() ?? []).filter((p) => p.window != null).length >= count,
    "the peer acknowledges",
  );
}

const pattern = (size: number, seed: number) =>
  new Uint8Array(size).map((_, i) => (i + seed) % 251);

describe("fair framing", () => {
  it("a small message on another port overtakes a large one in flight", async () => {
    const { a, arrivals } = pair({ frameSize: 16 * KiB });
    const bulk = await a.openPort("bulk");
    const ping = await a.openPort("ping");
    await acknowledged(a, 2);
    bulk.postMessage(pattern(256 * KiB, 1));
    ping.postMessage(new Uint8Array([42]));
    await waitFor(() => arrivals.length === 2, "both arrive");
    expect(arrivals.map((x) => x.port)).toEqual(["ping", "bulk"]);
    expect(arrivals[1]?.data).toEqual(pattern(256 * KiB, 1));
  });

  it("without frameSize the large message goes first, whole", async () => {
    const { a, arrivals } = pair({});
    const bulk = await a.openPort("bulk");
    const ping = await a.openPort("ping");
    await acknowledged(a, 2);
    bulk.postMessage(pattern(256 * KiB, 1));
    ping.postMessage(new Uint8Array([42]));
    await waitFor(() => arrivals.length === 2, "both arrive");
    expect(arrivals.map((x) => x.port)).toEqual(["bulk", "ping"]);
  });

  it("interleaved frames of several ports reassemble intact and in order", async () => {
    const { a, arrivals } = pair({ frameSize: 16 * KiB });
    const ports = await Promise.all(["p0", "p1", "p2"].map((name) => a.openPort(name)));
    await acknowledged(a, 3);
    ports.forEach((port, i) => {
      port.postMessage(pattern(64 * KiB, i));
      port.postMessage(pattern(10, i + 100));
    });
    await waitFor(() => arrivals.length === 6, "all six arrive");
    for (const [i, name] of ["p0", "p1", "p2"].entries()) {
      expect(arrivals.filter((x) => x.port === name).map((x) => x.data)).toEqual([
        pattern(64 * KiB, i),
        pattern(10, i + 100),
      ]);
    }
  });

  it("a close follows the last frame", async () => {
    const { a, b, arrivals } = pair({ frameSize: 16 * KiB });
    const port = await a.openPort("one");
    await acknowledged(a, 1);
    port.postMessage(pattern(96 * KiB, 7));
    await port.close?.();
    await waitFor(() => (b.ports?.() ?? []).length === 0, "the port closes on the peer");
    expect(arrivals.map((x) => x.data)).toEqual([pattern(96 * KiB, 7)]);
  });

  it("a peer that does not say it reads frames gets whole messages", async () => {
    let frames = 0;
    // The peer of an earlier version: it never advertises frames.
    const olderPeer: PortCodec = {
      post(port, envelope, transfer) {
        const { exact: _, ...rest } = envelope as typeof envelope & { exact?: unknown };
        msgpackCodec.post(port, rest as typeof envelope, transfer);
      },
      read(event) {
        const envelope = msgpackCodec.read(event);
        if (envelope?.type === ("frame" as string)) frames++;
        return envelope;
      },
    };
    const { a, arrivals } = pair({ frameSize: 16 * KiB }, olderPeer);
    const port = await a.openPort("one");
    await acknowledged(a, 1);
    port.postMessage(pattern(100 * KiB, 3));
    await waitFor(() => arrivals.length === 1, "it arrives");
    expect(frames).toBe(0);
    expect(arrivals[0]?.data).toEqual(pattern(100 * KiB, 3));
  });
});

describe("review fixes (#48)", () => {
  it("closing the mux still closes a port whose close waits behind its frames", async () => {
    const { a, b } = pair({ frameSize: 16 * KiB });
    const port = await a.openPort("one");
    await acknowledged(a, 1);
    port.postMessage(pattern(256 * KiB, 1));
    await port.close?.();
    await a.close();
    await waitFor(() => (b.ports?.() ?? []).length === 0, "the peer frees the port");
  });

  it("a port without a window posts at once: a buffer reused after postMessage is not read late", async () => {
    const { a, arrivals } = pair({ frameSize: 16 * KiB, window: 0 });
    const port = await a.openPort("plain");
    const buffer = new Uint8Array([1, 2, 3]);
    port.postMessage(buffer);
    buffer.fill(9);
    await waitFor(() => arrivals.length === 1, "it arrives");
    expect(arrivals[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("a pipe whose whenDrained rejects closes the mux", async () => {
    const channel = new MessageChannel();
    cleanups.push(() => channel.port1.close());
    const failure = new Error("pipe broke");
    const pipe: MessageTarget = {
      addEventListener: (_t, l: MessageListener) => channel.port1.addEventListener("message", l),
      removeEventListener: (_t, l: MessageListener) =>
        channel.port1.removeEventListener("message", l),
      postMessage: (m) => channel.port1.postMessage(m),
      whenDrained: () => Promise.reject(failure),
    };
    const a = multiplexPort(pipe, { codec: msgpackCodec, window: 64 * KiB, frameSize: 16 * KiB });
    cleanups.push(() => a.close());
    const port = await a.openPort("one");
    await port.close?.(); // the close goes through the pump
    await waitFor(() => a.ports().length === 0, "closed");
    await expect(a.openPort("two")).rejects.toThrow("the multiplexer is closed");
  });

  it("a frame on a port that never agreed exact sizes is dropped", async () => {
    const channel = new MessageChannel();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const got: unknown[] = [];
    const b = multiplexPort(channel.port2, {
      codec: msgpackCodec,
      side: "responder",
      onPort: (p) => {
        p.addEventListener("message", (e) => {
          got.push(e.data);
        });
        return true;
      },
    });
    cleanups.push(() => b.close());
    channel.port1.start();
    msgpackCodec.post(channel.port1, { type: "open", id: 0 }); // no window
    const inner = msgpackCodec.encode?.({ type: "message", id: 0, payload: "smuggled" });
    if (!inner) throw new Error("msgpackCodec.encode is required");
    msgpackCodec.post(channel.port1, { type: "frame", id: 0, data: inner, last: true });
    msgpackCodec.post(channel.port1, { type: "message", id: 0, payload: "plain" });
    await waitFor(() => got.length >= 1, "the plain message arrives");
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["plain"]);
  });
});

describe("a message reassembled from frames is bounded (#50)", () => {
  /**
   * A responder mux, and a raw peer on the other end that opens port 0 with an
   * exact-sized window and then posts whatever envelopes the test chooses.
   * `hold` makes the responder's listener never settle, so what it delivered
   * stays uncredited.
   */
  async function hostile(options: {
    window: number;
    maxReassembledBytes?: number;
    hold?: boolean;
  }) {
    const channel = new MessageChannel();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const got: unknown[] = [];
    const b = multiplexPort(channel.port2, {
      codec: msgpackCodec,
      side: "responder",
      maxReassembledBytes: options.maxReassembledBytes,
      onPort: (p) => {
        p.addEventListener("message", (e) => {
          got.push(e.data);
          return options.hold ? new Promise<void>(() => {}) : undefined;
        });
        return true;
      },
    });
    cleanups.push(() => b.close());
    const closes: unknown[] = [];
    channel.port1.addEventListener("message", (event) => {
      const envelope = msgpackCodec.read(event);
      if (envelope?.type === "close") closes.push(envelope.reason);
    });
    channel.port1.start();
    const peer = (envelope: Parameters<typeof msgpackCodec.post>[1]) =>
      msgpackCodec.post(channel.port1, envelope);
    peer({ type: "open", id: 0, window: options.window, exact: true });
    await waitFor(() => b.ports().length === 1, "the port opens");
    return { b, got, closes, peer };
  }

  it("frames past maxReassembledBytes close the port and free what they held", async () => {
    const { b, closes, peer } = await hostile({ window: 64 * KiB, maxReassembledBytes: 256 * KiB });
    for (let i = 0; i < 5; i++) peer({ type: "frame", id: 0, data: pattern(64 * KiB, i) });
    await waitFor(() => closes.length > 0, "the responder closes the port");
    expect(closes).toEqual(["max-reassembled-bytes"]);
    expect(b.ports()).toEqual([]);
  });

  it("frames past what the window leaves close the port, under the cap", async () => {
    const { b, got, closes, peer } = await hostile({ window: 64 * KiB, hold: true });
    peer({ type: "message", id: 0, payload: pattern(40 * KiB, 0) });
    await waitFor(() => got.length === 1, "the held message arrives");
    peer({ type: "frame", id: 0, data: pattern(16 * KiB, 1) });
    peer({ type: "frame", id: 0, data: pattern(16 * KiB, 2) });
    await waitFor(() => closes.length > 0, "the responder closes the port");
    expect(closes).toEqual(["max-reassembled-bytes"]);
    expect(b.ports()).toEqual([]);
  });

  it("a framed message larger than the window, just under the cap, arrives whole", async () => {
    const { a, arrivals } = pair({
      frameSize: 16 * KiB,
      window: 64 * KiB,
      maxReassembledBytes: 256 * KiB,
    });
    const port = await a.openPort("big");
    await acknowledged(a, 1);
    const data = pattern(240 * KiB, 7);
    port.postMessage(data);
    await waitFor(() => arrivals.length === 1, "the large message arrives");
    expect(arrivals[0]?.data).toEqual(data);
  });
});

describe("frameSize validation", () => {
  it.each([0, -1, 1.5, Number.NaN])(
    "refuses frameSize %s instead of hanging",
    async (frameSize) => {
      const { port1, port2 } = new MessageChannel();
      try {
        expect(() => multiplexPort(port1, { codec: msgpackCodec, frameSize })).toThrow(RangeError);
        expect(() =>
          multiplexPort(port1, { codec: msgpackCodec, maxReassembledBytes: frameSize }),
        ).toThrow(RangeError);
      } finally {
        port1.close();
        port2.close();
      }
    },
  );
});
