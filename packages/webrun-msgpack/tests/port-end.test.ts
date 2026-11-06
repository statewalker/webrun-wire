import {
  endPort,
  type MessageListener,
  type MessageTarget,
  multiplexPort,
  type PortCodec,
  type PortEnvelope,
  whenPortEnded,
} from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });

import { msgpackCodec } from "../src/index.js";

// PROTOTYPE (T-3, mux-lifecycle): a per-direction `end` on a windowed port,
// agreed in `open` and its window ack, must leave behind everything queued
// for that port (window queue and fair-framing ring), and once both
// directions have ended the id is freed on both ends with no close().

const KiB = 1024;
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

/** A narrow link: one message per tick to the real port, reporting its backlog. */
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
    decode(data) {
      const envelope = codec.decode?.(data);
      if (envelope) seen.push(`decoded:${envelope.type}`);
      return envelope;
    },
  };
}

function pair(options: { aCaps?: string[]; bCaps?: string[] } = {}) {
  const { port1, port2 } = new MessageChannel();
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
  const seenA: string[] = [];
  const seenB: string[] = [];
  const common = { window: 32 * KiB, frameSize: 4 * KiB };
  const accepted: MessageTarget[] = [];
  const a = multiplexPort(slowPipe(port1), {
    ...common,
    codec: tapped(msgpackCodec, seenA),
    side: "initiator",
    ...(options.aCaps ? { capabilities: options.aCaps } : {}),
  });
  const b = multiplexPort(slowPipe(port2), {
    ...common,
    codec: tapped(msgpackCodec, seenB),
    side: "responder",
    ...(options.bCaps ? { capabilities: options.bCaps } : {}),
    onPort: (port) => {
      accepted.push(port);
    },
  });
  cleanups.push(() => a.close());
  cleanups.push(() => b.close());
  return { a, b, accepted, seenA, seenB };
}

/** Records the bytes a port receives, consuming each message slowly. */
function receiver(port: MessageTarget) {
  const state = { bytes: 0, bytesAtEnd: -1, ended: false };
  port.addEventListener("message", (event) => {
    state.bytes += (event.data as Uint8Array).byteLength;
    // A slow consumer: the window stays spent, so the sender's queue fills.
    return new Promise<void>((r) => setTimeout(r, 1));
  });
  void whenPortEnded(port).then(() => {
    state.ended = true;
    state.bytesAtEnd = state.bytes;
  });
  return state;
}

/** Many small messages, then a large last one, then end. Returns the bytes sent. */
function sendAll(port: MessageTarget): { total: number; ended: Promise<boolean> } {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const chunk = new Uint8Array(3 * KiB).fill(i);
    total += chunk.byteLength;
    port.postMessage(chunk);
  }
  const last = new Uint8Array(200 * KiB).fill(7);
  total += last.byteLength;
  port.postMessage(last);
  return { total, ended: endPort(port) };
}

describe("PROTOTYPE T-3: mux end ordered behind frames", () => {
  it("delivers every byte before the end, in both directions, then frees the id on both ends", async () => {
    const { a, b, accepted, seenA, seenB } = pair();
    const portA = await a.openPort({ kind: "stream" });
    await waitFor(() => accepted.length === 1, "B accepts the port");
    // Frames go only once both ends enforce the window (the ack round trip).
    await waitFor(
      () => a.ports()[0]?.window != null && b.ports()[0]?.window != null,
      "window in force on both ends",
    );
    // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
    const portB = accepted[0]!;
    const atB = receiver(portB);
    const atA = receiver(portA);

    const fromA = sendAll(portA);
    const fromB = sendAll(portB);
    // While A's end waits behind its frames, A still has the port.
    expect(a.ports()).toHaveLength(1);

    expect(await fromA.ended).toBe(true);
    expect(await fromB.ended).toBe(true);
    await waitFor(() => atA.ended && atB.ended, "both ends see the peer's end");
    expect(atB.bytesAtEnd).toBe(fromA.total);
    expect(atA.bytesAtEnd).toBe(fromB.total);
    // Frames really were used (the test exercises the ring).
    expect(seenB).toContain("frame");
    expect(seenA).toContain("frame");
    expect(seenA).toContain("end");
    expect(seenB).toContain("end");

    await waitFor(() => a.ports().length === 0 && b.ports().length === 0, "ids freed");
    expect(seenA).not.toContain("close");
    expect(seenB).not.toContain("close");
  });

  it("keeps credit flowing to a port that ended only one direction", async () => {
    const { a, b, accepted } = pair();
    const portA = await a.openPort({ kind: "stream" });
    await waitFor(() => accepted.length === 1, "B accepts the port");
    // Frames go only once both ends enforce the window (the ack round trip).
    await waitFor(
      () => a.ports()[0]?.window != null && b.ports()[0]?.window != null,
      "window in force on both ends",
    );
    // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
    const portB = accepted[0]!;
    const atA = receiver(portA);
    receiver(portB);
    // A ends its direction at once, with nothing sent.
    expect(await endPort(portA)).toBe(true);
    // B then sends far more than one window: it only completes if A, which
    // has ended its own direction, keeps granting credit.
    const fromB = sendAll(portB);
    expect(await fromB.ended).toBe(true);
    await waitFor(() => atA.ended, "A sees B's end");
    expect(atA.bytesAtEnd).toBe(fromB.total);
    await waitFor(() => a.ports().length === 0 && b.ports().length === 0, "ids freed");
  });

  it.each([
    ["the opener", { aCaps: [] }],
    ["the responder", { bCaps: [] }],
  ])("never sends end when %s does not list it", async (_who, caps) => {
    const { a, b, accepted, seenA, seenB } = pair(caps);
    const portA = await a.openPort({ kind: "stream" });
    await waitFor(() => accepted.length === 1, "B accepts the port");
    // Frames go only once both ends enforce the window (the ack round trip).
    await waitFor(
      () => a.ports()[0]?.window != null && b.ports()[0]?.window != null,
      "window in force on both ends",
    );
    // biome-ignore lint/style/noNonNullAssertion: checked by the wait above.
    const portB = accepted[0]!;
    receiver(portA);
    receiver(portB);
    // Not agreed: endPort says so, and the caller falls back to close().
    const fromA = sendAll(portA);
    const fromB = sendAll(portB);
    expect(await fromA.ended).toBe(false);
    expect(await fromB.ended).toBe(false);
    portA.close();
    await waitFor(() => seenB.includes("close"), "B sees the close");
    expect(seenA.filter((t) => t === "end")).toEqual([]);
    expect(seenB.filter((t) => t === "end")).toEqual([]);
  });
});

// Type-only: the prototype's wire envelope.
export type _End = Extract<PortEnvelope, { type: "end" }>;
