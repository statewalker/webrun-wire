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
  options: { frameSize?: number; window?: number },
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
    bulk.postMessage(pattern(1024 * KiB, 1));
    ping.postMessage(new Uint8Array([42]));
    await waitFor(() => arrivals.length === 2, "both arrive");
    expect(arrivals.map((x) => x.port)).toEqual(["ping", "bulk"]);
    expect(arrivals[1]?.data).toEqual(pattern(1024 * KiB, 1));
  });

  it("without frameSize the large message goes first, whole", async () => {
    const { a, arrivals } = pair({});
    const bulk = await a.openPort("bulk");
    const ping = await a.openPort("ping");
    await acknowledged(a, 2);
    bulk.postMessage(pattern(1024 * KiB, 1));
    ping.postMessage(new Uint8Array([42]));
    await waitFor(() => arrivals.length === 2, "both arrive");
    expect(arrivals.map((x) => x.port)).toEqual(["bulk", "ping"]);
  });

  it("interleaved frames of several ports reassemble intact and in order", async () => {
    const { a, arrivals } = pair({ frameSize: 16 * KiB });
    const ports = await Promise.all(["p0", "p1", "p2"].map((name) => a.openPort(name)));
    await acknowledged(a, 3);
    ports.forEach((port, i) => {
      port.postMessage(pattern(200 * KiB, i));
      port.postMessage(pattern(10, i + 100));
    });
    await waitFor(() => arrivals.length === 6, "all six arrive");
    for (const [i, name] of ["p0", "p1", "p2"].entries()) {
      expect(arrivals.filter((x) => x.port === name).map((x) => x.data)).toEqual([
        pattern(200 * KiB, i),
        pattern(10, i + 100),
      ]);
    }
  });

  it("a close follows the last frame", async () => {
    const { a, b, arrivals } = pair({ frameSize: 16 * KiB });
    const port = await a.openPort("one");
    await acknowledged(a, 1);
    port.postMessage(pattern(300 * KiB, 7));
    await port.close?.();
    await waitFor(() => (b.ports?.() ?? []).length === 0, "the port closes on the peer");
    expect(arrivals.map((x) => x.data)).toEqual([pattern(300 * KiB, 7)]);
  });

  it("a peer that does not say it reads frames gets whole messages", async () => {
    let frames = 0;
    // The peer of an earlier version: it never advertises frames.
    const olderPeer: PortCodec = {
      post(port, envelope, transfer) {
        const { frames: _, ...rest } = envelope as typeof envelope & { frames?: unknown };
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
