import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  type MessageTarget,
  multiplexPort,
  type PortEnvelope,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

// A peer that pipelines where it may not: where pipelining was not agreed, or
// past the window it was given. Either fails the stream and closes the port,
// and the receiver holds no more than the window plus one chunk.

const KiB = 1024;
const MiB = 1024 * KiB;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Bytes of `ArrayBuffer`s alive after a full collection. */
async function liveBuffers(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 10));
  }
  return process.memoryUsage().arrayBuffers;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A pipelined chunk on the handler's input, as layer 2 writes it. */
const chunk = (bytes: number) => ({
  type: "webrun-rpc:chunk",
  channelName: "in",
  chunk: { done: false, value: new Uint8Array(bytes) },
});

/**
 * A responder mux on one end of a channel whose ports each serve a stream
 * with a handler that waits for `gate` before reading its input, then records
 * how its input ended. `sample` runs after every message the mux handles.
 */
function responder(sample: () => void = () => {}) {
  const ch = new MessageChannel();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ended: unknown[] = [];
  const wrapped = new Map<unknown, (e: MessageEvent) => void>();
  const pipe: MessageTarget = {
    postMessage: (m, t) => ch.port2.postMessage(m, t ?? []),
    addEventListener(type, listener) {
      const w = (e: MessageEvent) => {
        listener(e);
        sample();
      };
      wrapped.set(listener, w);
      ch.port2.addEventListener(type, w);
    },
    removeEventListener(type, listener) {
      const w = wrapped.get(listener);
      if (w) ch.port2.removeEventListener(type, w);
    },
    start: () => ch.port2.start(),
  };
  const mux = multiplexPort(pipe, {
    codec: structuredCodec,
    side: "responder",
    onPort: (port) => {
      serveDuplexOverPort(port, async function* (input) {
        await gate;
        try {
          for await (const _ of input) {
          }
          ended.push("done");
        } catch (err) {
          ended.push(err);
        }
        yield new Uint8Array(0);
      });
      return true;
    },
  });
  cleanups.push(async () => {
    release();
    await mux.close();
    ch.port1.close();
    ch.port2.close();
  });
  return { wire: ch.port1, mux, release, ended };
}

/** The hostile opener at the wire: posts envelopes, and records what comes back. */
function hostile(wire: MessagePort) {
  const received: PortEnvelope[] = [];
  wire.addEventListener("message", (e) => {
    const envelope = structuredCodec.read(e);
    if (envelope) received.push(envelope);
  });
  wire.start();
  return { post: (envelope: PortEnvelope) => wire.postMessage(envelope), received };
}

describe("duplexOverPort — a peer that pipelines where it may not", () => {
  it("a pipelined chunk on a port with no window fails the stream and closes the port", async () => {
    const ch = new MessageChannel();
    const ended: unknown[] = [];
    const server = multiplexPort(ch.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (port) => {
        serveDuplexOverPort(port, async function* (input) {
          try {
            for await (const _ of input) {
            }
          } catch (err) {
            ended.push(err);
          }
          yield new Uint8Array(0);
        });
        return true;
      },
    });
    const client = multiplexPort(ch.port1, { codec: structuredCodec, side: "initiator" });
    cleanups.push(async () => {
      await client.close();
      await server.close();
      ch.port1.close();
      ch.port2.close();
    });

    const port = await client.openPort({ kind: "stream" });
    port.postMessage(chunk(16));

    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/pipelining was not agreed/);
    await waitFor(
      "both ends free the port",
      () => !client.ports().length && !server.ports().length,
    );
  });

  it("a pipelined chunk from an opener that listed no capabilities fails the stream and closes the port", async () => {
    const { wire, mux, release, ended } = responder();
    const peer = hostile(wire);
    // A window, as today's published version asks for it: no `caps`.
    peer.post({ type: "open", id: 0, meta: { kind: "stream" }, window: 64 * KiB });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0 });
    peer.post({ type: "message", id: 0, payload: chunk(16) });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(peer.received[0]).toEqual({ type: "credit", id: 0, bytes: 0 });
    expect(mux.ports()).toEqual([]);
    release();
    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/pipelining was not agreed/);
  });

  it("a sender that ignores credit fails its stream past the window plus one chunk, and the receiver holds no more", async () => {
    const WINDOW = 64 * KiB;
    const CHUNK = 4 * KiB;
    let mostHeld = 0;
    let oneChunk = 0;
    const { wire, mux, release, ended } = responder(() => {
      const held = mux.ports()[0]?.unconsumed ?? 0;
      if (held && !oneChunk) oneChunk = held;
      mostHeld = Math.max(mostHeld, held);
    });
    const peer = hostile(wire);
    peer.post({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
      window: WINDOW,
      caps: ["pipeline"],
    });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    expect(peer.received[0]).toEqual({ type: "credit", id: 0, bytes: 0, caps: ["pipeline"] });
    peer.post({ type: "credit", id: 0, bytes: 0 });
    // Four windows' worth, never waiting for credit; the handler reads nothing.
    for (let sent = 0; sent < 4 * WINDOW; sent += CHUNK) {
      peer.post({ type: "message", id: 0, payload: chunk(CHUNK) });
    }

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(oneChunk).toBeGreaterThan(CHUNK);
    expect(mostHeld).toBeGreaterThan(WINDOW);
    expect(mostHeld).toBeLessThanOrEqual(WINDOW + oneChunk);
    expect(mux.ports()).toEqual([]);
    release();
    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/past the window/);
  });

  it("chunks that are small views on large buffers hold only their own bytes", async () => {
    // Structured clone carries a view's whole buffer. Counted by the view, 200
    // one-byte chunks on 1 MiB buffers fit a 64 KiB window, so they are not
    // refused: what must hold is that the receiver keeps their bytes, not
    // their buffers.
    const WINDOW = 64 * KiB;
    const { wire, mux } = responder();
    const peer = hostile(wire);
    peer.post({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
      window: WINDOW,
      caps: ["pipeline"],
    });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0 });
    const before = await liveBuffers();
    for (let i = 0; i < 200; i++) {
      const value = new Uint8Array(new ArrayBuffer(MiB), 0, 1);
      peer.post({
        type: "message",
        id: 0,
        payload: { ...chunk(0), chunk: { done: false, value } },
      });
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor("all of them are held", () => (mux.ports()[0]?.unconsumed ?? 0) >= 200 * 64);
    const held = (await liveBuffers()) - before;
    expect(mux.ports()).toHaveLength(1);
    expect(held).toBeLessThanOrEqual(WINDOW + MiB);
  });

  it("a confirmed chunk beside pipelined ones fails the stream and closes the port", async () => {
    const { wire, mux, release, ended } = responder();
    const peer = hostile(wire);
    peer.post({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
      window: 64 * KiB,
      caps: ["pipeline"],
    });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0 });
    // One confirmed chunk the stalled handler holds, then a pipelined one.
    const request = { type: "request", channelName: "in", callId: "c1", params: chunk(16).chunk };
    peer.post({ type: "message", id: 0, payload: request });
    peer.post({ type: "message", id: 0, payload: chunk(16) });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(mux.ports()).toEqual([]);
    release();
    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/mixed confirmed and pipelined/);
  });

  it("an opener refuses a pipelined chunk from a responder that never agreed", async () => {
    const ch = new MessageChannel();
    const client = multiplexPort(ch.port1, {
      codec: structuredCodec,
      side: "initiator",
      window: 64 * KiB,
    });
    cleanups.push(async () => {
      await client.close();
      ch.port1.close();
      ch.port2.close();
    });
    // The responder at the wire: no ack, then output pipelined straight away.
    const peer = hostile(ch.port2);
    peer.received.length = 0;
    const port = await client.openPort({ kind: "stream" });
    await waitFor("the open arrives", () => peer.received.some((e) => e.type === "open"));
    peer.post({ type: "message", id: 0, payload: { ...chunk(16), channelName: "out" } });

    let error: unknown;
    try {
      for await (const _ of duplexOverPort(port)([new Uint8Array([1])])) {
      }
    } catch (err) {
      error = err;
    }
    expect((error as Error)?.message).toMatch(/pipelining was not agreed/);
    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(client.ports()).toEqual([]);
  });

  it("a confirmed chunk after pipelined ones fails the stream and closes the port", async () => {
    const { wire, mux, release, ended } = responder();
    const peer = hostile(wire);
    peer.post({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
      window: 64 * KiB,
      caps: ["pipeline"],
    });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0 });
    // A pipelined chunk the stalled handler holds, then a confirmed one.
    peer.post({ type: "message", id: 0, payload: chunk(16) });
    const request = { type: "request", channelName: "in", callId: "c1", params: chunk(16).chunk };
    peer.post({ type: "message", id: 0, payload: request });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(mux.ports()).toEqual([]);
    release();
    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/mixed confirmed and pipelined/);
  });

  it("a pipelined chunk whose value is not bytes fails the stream and closes the port", async () => {
    const { wire, mux, release, ended } = responder();
    const peer = hostile(wire);
    peer.post({
      type: "open",
      id: 0,
      meta: { kind: "stream" },
      window: 64 * KiB,
      caps: ["pipeline"],
    });
    await waitFor("the window is acknowledged", () => peer.received.length > 0);
    peer.post({ type: "credit", id: 0, bytes: 0 });
    const notBytes = { ...chunk(0), chunk: { done: false, value: { byteLength: -1e12 } } };
    peer.post({ type: "message", id: 0, payload: notBytes });

    await waitFor("the port is closed", () => peer.received.some((e) => e.type === "close"));
    expect(mux.ports()).toEqual([]);
    release();
    await waitFor("the handler's input fails", () => ended.length > 0);
    expect((ended[0] as Error).message).toMatch(/whose value is not bytes/);
  });

  it("a confirmed chunk that is a small view on a large buffer is held as its own bytes", async () => {
    const { wire, mux } = responder();
    const peer = hostile(wire);
    peer.post({ type: "open", id: 0, meta: { kind: "stream" } });
    await waitFor("the port opens", () => mux.ports().length === 1);
    const before = await liveBuffers();
    // Built in place, so this test keeps no reference to the buffer itself.
    peer.post({
      type: "message",
      id: 0,
      payload: {
        type: "request",
        channelName: "in",
        callId: "c1",
        params: { done: false, value: new Uint8Array(new ArrayBuffer(8 * MiB), 0, 1) },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const held = (await liveBuffers()) - before;
    expect(mux.ports()).toHaveLength(1);
    expect(held).toBeLessThan(MiB);
  });
});
