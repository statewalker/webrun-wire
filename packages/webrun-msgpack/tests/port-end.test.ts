import { afterEach, describe, expect, it } from "vitest";
// webrun-rpc by path, from its source: the half-close helpers are internal
// (not exported from its index), and they must be the same module instance as
// the `multiplexPort` that registers its ports with them, also when this runs
// from the package's own directory, where the package name resolves to `dist`.
import {
  getPortCloseSignal,
  type MessageListener,
  type MessageTarget,
  multiplexPort,
  type PortCodec,
} from "../../webrun-rpc/src/index.js";
import { endPort, whenPortEnded } from "../../webrun-rpc/src/port-credit.js";
import { msgpackCodec } from "../src/index.js";

// A per-direction `end` on a windowed port: it leaves behind everything
// already posted on that port (its window queue, then the fair-framing ring),
// and once both directions have ended the id is freed on both ends, with no
// `close` on the wire.

const KiB = 1024;
const WINDOW = 32 * KiB;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A narrow link: a few messages per tick to the real port, reporting its backlog. */
function slowPipe(port: MessagePort, room = 16 * KiB): MessageTarget {
  const queue: Uint8Array[] = [];
  let buffered = 0;
  const drained: Array<() => void> = [];
  const timer = setInterval(() => {
    for (let i = 0; i < 4; i++) {
      const next = queue.shift();
      if (!next) break;
      buffered -= next.byteLength;
      port.postMessage(next);
    }
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

/** The codec, recording the type of every envelope this end reads. */
function tapped(codec: PortCodec, seen: string[]): PortCodec {
  return {
    ...codec,
    read(event) {
      const envelope = codec.read(event);
      if (envelope) seen.push(envelope.type);
      return envelope;
    },
  };
}

/** Two muxes with a window and `frameSize` over slow pipes, one port open and its window in force. */
async function pair() {
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
  const seenA: string[] = [];
  const seenB: string[] = [];
  const common = { window: WINDOW, frameSize: 4 * KiB };
  const accepted: MessageTarget[] = [];
  const a = multiplexPort(slowPipe(port1), { ...common, codec: tapped(msgpackCodec, seenA) });
  const b = multiplexPort(slowPipe(port2), {
    ...common,
    codec: tapped(msgpackCodec, seenB),
    side: "responder",
    onPort: (port) => {
      accepted.push(port);
    },
  });
  cleanups.push(() => a.close());
  cleanups.push(() => b.close());
  const portA = await a.openPort({ kind: "stream" });
  await waitFor(() => accepted.length === 1, "B accepts the port");
  // Frames go only once both ends enforce the window (the ack round trip).
  await waitFor(
    () => a.ports()[0]?.window != null && b.ports()[0]?.window != null,
    "window in force on both ends",
  );
  // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
  const portB = accepted[0]!;
  return { a, b, portA, portB, seenA, seenB };
}

/**
 * Records what a port receives and what it had when the peer's end came. A
 * slow consumer by default (the window stays spent, so the sender queues);
 * `stall` never consumes at all.
 */
function receiver(port: MessageTarget, { stall = false } = {}) {
  const state = { sizes: [] as number[], bytes: 0, sizesAtEnd: [] as number[], ended: false };
  port.addEventListener("message", (event) => {
    const size = (event.data as Uint8Array).byteLength;
    state.sizes.push(size);
    state.bytes += size;
    return new Promise<void>((r) => {
      if (!stall) setTimeout(r, 1);
    });
  });
  void whenPortEnded(port).then(() => {
    state.ended = true;
    state.sizesAtEnd = [...state.sizes];
  });
  return state;
}

/** Many small messages (more than the window), then one larger than the window, then end. */
function sendAll(port: MessageTarget): { sizes: number[]; ended: boolean } {
  const sizes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const chunk = new Uint8Array(3 * KiB).fill(i);
    sizes.push(chunk.byteLength);
    port.postMessage(chunk);
  }
  const last = new Uint8Array(200 * KiB).fill(7);
  sizes.push(last.byteLength);
  port.postMessage(last);
  return { sizes, ended: endPort(port) };
}

describe("end on a windowed port (msgpackCodec, window, frameSize, slow pipe)", () => {
  it("delivers a last message larger than the window whole before its end, in both directions, then frees the id with no close", async () => {
    const { a, b, portA, portB, seenA, seenB } = await pair();
    const atA = receiver(portA);
    const atB = receiver(portB);

    const fromA = sendAll(portA);
    const fromB = sendAll(portB);
    expect(fromA.ended).toBe(true);
    expect(fromB.ended).toBe(true);
    // The ends wait behind the frames: the port is still open on both sides.
    expect(a.ports()).toHaveLength(1);
    expect(b.ports()).toHaveLength(1);

    await waitFor(() => atA.ended && atB.ended, "both ends see the peer's end");
    expect(atB.sizesAtEnd).toEqual(fromA.sizes);
    expect(atA.sizesAtEnd).toEqual(fromB.sizes);
    // The last message really went as frames, through the ring.
    expect(seenA).toContain("frame");
    expect(seenB).toContain("frame");

    await waitFor(() => a.ports().length === 0 && b.ports().length === 0, "ids freed");
    expect(seenA.filter((t) => t === "end")).toHaveLength(1);
    expect(seenB.filter((t) => t === "end")).toHaveLength(1);
    expect(seenA).not.toContain("close");
    expect(seenB).not.toContain("close");
  });

  it("one-sided: a side whose peer ended first keeps sending and getting credit until it ends", async () => {
    const { a, b, portA, portB } = await pair();
    const atA = receiver(portA);
    const atB = receiver(portB);
    // A ends its direction at once, with nothing sent.
    expect(endPort(portA)).toBe(true);
    await waitFor(() => atB.ended, "B sees A's end");
    expect(b.ports()).toHaveLength(1);

    // B then sends several windows' worth: it only gets through if A, which
    // has ended its own direction, keeps granting credit.
    const fromB = sendAll(portB);
    expect(fromB.ended).toBe(true);
    await waitFor(() => atA.ended, "A sees B's end");
    expect(atA.sizesAtEnd).toEqual(fromB.sizes);
    await waitFor(() => a.ports().length === 0 && b.ports().length === 0, "ids freed");
  });

  it("the end needs no credit: it reaches a peer whose consumer still holds the last message", async () => {
    const { portA, portB } = await pair();
    const atB = receiver(portB, { stall: true });
    portA.postMessage(new Uint8Array(200 * KiB));
    expect(endPort(portA)).toBe(true);
    await waitFor(() => atB.ended, "B sees A's end");
    expect(atB.sizesAtEnd).toEqual([200 * KiB]);
  });

  it("drops what is posted after the end, and sends the end once", async () => {
    const { portA, portB, seenB } = await pair();
    const atB = receiver(portB);
    portA.postMessage(new Uint8Array(1 * KiB));
    expect(endPort(portA)).toBe(true);
    expect(endPort(portA)).toBe(true);
    portA.postMessage(new Uint8Array(2 * KiB));
    await waitFor(() => atB.ended, "B sees A's end");
    // Long enough for anything posted after the end to have arrived.
    await new Promise((r) => setTimeout(r, 50));
    expect(atB.sizes).toEqual([1 * KiB]);
    expect(seenB.filter((t) => t === "end")).toHaveLength(1);
  });

  it("whenPortEnded resolves also when first asked after the end arrived", async () => {
    const { portA, portB, seenB } = await pair();
    expect(endPort(portA)).toBe(true);
    await waitFor(() => seenB.includes("end"), "B reads A's end");
    await whenPortEnded(portB);
  });

  it("a port closed with its end still queued sends the close alone, and refuses a later end", async () => {
    const { a, portA, portB, seenB } = await pair();
    receiver(portB, { stall: true });
    // The first message spends the window and the stalled peer returns no
    // credit, so the second, and the end behind it, stay queued.
    portA.postMessage(new Uint8Array(200 * KiB));
    portA.postMessage(new Uint8Array(1 * KiB));
    expect(endPort(portA)).toBe(true);
    await waitFor(() => (a.ports()[0]?.queued ?? 0) > 0, "the second message waits for credit");
    const signal = getPortCloseSignal(portB);
    portA.close?.();
    expect(endPort(portA)).toBe(false);
    await waitFor(() => seenB.includes("close"), "B reads the close");
    expect(seenB).not.toContain("end");
    expect(signal?.reason).toMatchObject({ message: "webrun-rpc: the peer closed the port" });
  });
});
