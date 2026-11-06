import { afterEach, describe, expect, it } from "vitest";
import { getPortCloseSignal } from "../src/close-signal.js";
import type { MessageTarget } from "../src/message-target.js";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortCodec, PortMux, PortMuxOptions } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

// #39 proposal 4: a mux-level ping/pong tells a dead or stalled peer from a
// quiet one, which no event of a MessagePort can.

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];
afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((m) => m.close()));
  for (const p of rawPorts.splice(0)) p.close();
});

/** A codec whose end can go silent, as a frozen or killed realm does. */
function silenceable(codec: PortCodec = structuredCodec) {
  const state = { silent: false };
  const wrapped: PortCodec = {
    post: (port, envelope, transfer) => {
      if (!state.silent) codec.post(port, envelope, transfer);
    },
    read: (e) => codec.read(e),
  };
  return { state, codec: wrapped };
}

function pair(a: Partial<PortMuxOptions>, b: Partial<PortMuxOptions> & { codec?: PortCodec } = {}) {
  const ch = new MessageChannel();
  rawPorts.push(ch.port1, ch.port2);
  const ma = multiplexPort(ch.port1, { codec: structuredCodec, side: "initiator", ...a });
  const mb = multiplexPort(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    onPort: () => true,
    ...b,
  });
  muxes.push(ma, mb);
  return { a: ma, b: mb };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keepalive = { intervalMs: 20, misses: 3 };

describe("keepalive", () => {
  it("a peer that stops answering closes the mux within interval × misses", async () => {
    const peer = silenceable();
    const { a } = pair({ keepalive }, { keepalive, codec: peer.codec });
    const port = await a.openPort();
    await sleep(60); // the peer has answered: it speaks keepalive
    peer.state.silent = true;
    const started = Date.now();
    const signal = getPortCloseSignal(port);
    if (!signal) throw new Error("a virtual port has a close signal");
    await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    expect(Date.now() - started).toBeLessThan(keepalive.intervalMs * (keepalive.misses + 2) + 50);
    expect(String((signal.reason as Error).message)).toContain("did not answer");
    await expect(a.openPort()).rejects.toThrow("the multiplexer is closed");
  });

  it("a quiet but live peer keeps the mux open, by answering pings at this end's pace", async () => {
    // The peer pings every 100 ms, slower than this end tolerates (20 ms × 3):
    // only its answers to this end's pings keep the mux open.
    const { a } = pair({ keepalive }, { keepalive: { intervalMs: 100 } });
    const port = await a.openPort();
    await sleep(keepalive.intervalMs * keepalive.misses * 4);
    expect(getPortCloseSignal(port)?.aborted).toBe(false);
  });

  it("a peer without keepalive is never closed for it", async () => {
    // An older peer: its codec drops what it does not know.
    const older: PortCodec = {
      post: (port, envelope, transfer) => structuredCodec.post(port, envelope, transfer),
      read: (e) => {
        const envelope = structuredCodec.read(e);
        return envelope?.type === ("ping" as string) || envelope?.type === ("pong" as string)
          ? undefined
          : envelope;
      },
    };
    const { a } = pair({ keepalive }, { codec: older });
    const port = await a.openPort();
    await sleep(keepalive.intervalMs * keepalive.misses * 4);
    expect(getPortCloseSignal(port)?.aborted).toBe(false);
  });

  it("any traffic from the peer counts as alive", async () => {
    // Once the peer has answered, its pings and pongs stop, but it keeps
    // sending its own messages.
    const quiet = { probes: true };
    const noProbes: PortCodec = {
      post: (port, envelope, transfer) => {
        const probe = envelope.type === ("ping" as string) || envelope.type === ("pong" as string);
        if (quiet.probes || !probe) structuredCodec.post(port, envelope, transfer);
      },
      read: (e) => structuredCodec.read(e),
    };
    let peerPort: { postMessage(m: unknown): void } | undefined;
    const { a } = pair(
      { keepalive },
      {
        keepalive,
        codec: noProbes,
        onPort: (p) => {
          peerPort = p;
          return true;
        },
      },
    );
    const port = await a.openPort();
    port.postMessage("hello");
    await sleep(60); // the peer has answered: it speaks keepalive
    quiet.probes = false;
    const ticker = setInterval(() => peerPort?.postMessage("tick"), keepalive.intervalMs / 2);
    try {
      await sleep(keepalive.intervalMs * keepalive.misses * 4);
      expect(getPortCloseSignal(port)?.aborted).toBe(false);
    } finally {
      clearInterval(ticker);
    }
  });

  it("an interval that is not a positive number is a RangeError", () => {
    const ch = new MessageChannel();
    rawPorts.push(ch.port1, ch.port2);
    expect(() =>
      multiplexPort(ch.port1, { codec: structuredCodec, keepalive: { intervalMs: 0 } }),
    ).toThrow(RangeError);
  });

  it("misses: 1 keeps a live peer, and closes a silent one after one interval", async () => {
    const peer = silenceable();
    const one = { intervalMs: 30, misses: 1 };
    const { a } = pair({ keepalive: one }, { keepalive: one, codec: peer.codec });
    const port = await a.openPort();
    await sleep(one.intervalMs * 8);
    const signal = getPortCloseSignal(port);
    expect(signal?.aborted).toBe(false);
    peer.state.silent = true;
    await new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
  });

  it("closes no sooner than interval × misses after the last thing the peer sent", async () => {
    const peer = silenceable();
    const slow = { intervalMs: 50, misses: 3 };
    const { a } = pair({ keepalive: slow }, { keepalive: slow, codec: peer.codec });
    const port = await a.openPort();
    await sleep(120);
    peer.state.silent = true;
    const silentSince = Date.now();
    const signal = getPortCloseSignal(port);
    await new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
    expect(Date.now() - silentSince).toBeGreaterThanOrEqual(slow.intervalMs * slow.misses - 10);
  });

  it("its own unsent backlog is not the peer's silence", async () => {
    // This end's transport still holds bytes: its pings have not left yet.
    const ch = new MessageChannel();
    rawPorts.push(ch.port1, ch.port2);
    const backlogged = Object.assign(ch.port1, { bufferedAmount: 1 });
    const peer = silenceable();
    const a = multiplexPort(backlogged, { codec: structuredCodec, keepalive });
    const b = multiplexPort(ch.port2, {
      codec: peer.codec,
      side: "responder",
      onPort: () => true,
      keepalive,
    });
    muxes.push(a, b);
    const port = await a.openPort();
    await sleep(60);
    peer.state.silent = true;
    await sleep(keepalive.intervalMs * keepalive.misses * 4);
    expect(getPortCloseSignal(port)?.aborted).toBe(false);
  });

  it("a ping does not close port 0 on an older mux that takes unknown envelopes for close", async () => {
    // An older mux treats every type it does not know as a close of that id.
    const olderMux: PortCodec = {
      post: (port, envelope, transfer) => structuredCodec.post(port, envelope, transfer),
      read: (e) => {
        const envelope = structuredCodec.read(e);
        return envelope?.type === ("ping" as string) || envelope?.type === ("pong" as string)
          ? { type: "close", id: envelope.id }
          : envelope;
      },
    };
    let accepted: MessageTarget | undefined;
    const { a } = pair(
      { keepalive },
      {
        codec: olderMux,
        onPort: (p) => {
          accepted = p;
          return true;
        },
      },
    );
    const port = await a.openPort(); // id 0, the initiator's first port
    port.postMessage("hello");
    await sleep(keepalive.intervalMs * 4);
    expect(accepted && getPortCloseSignal(accepted)?.aborted).toBe(false);
  });

  it("an interval past what timers can hold is a RangeError", () => {
    const ch = new MessageChannel();
    rawPorts.push(ch.port1, ch.port2);
    expect(() =>
      multiplexPort(ch.port1, { codec: structuredCodec, keepalive: { intervalMs: 2 ** 31 } }),
    ).toThrow(RangeError);
  });

  it("one end is enough: a current peer without the option still answers, so its silence is caught", async () => {
    const peer = silenceable();
    const { a } = pair({ keepalive }, { codec: peer.codec });
    const port = await a.openPort();
    await sleep(keepalive.intervalMs * keepalive.misses * 3);
    const signal = getPortCloseSignal(port);
    expect(signal?.aborted).toBe(false);
    peer.state.silent = true;
    await new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
  });
});
