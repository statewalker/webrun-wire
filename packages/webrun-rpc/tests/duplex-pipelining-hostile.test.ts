import { afterEach, describe, expect, it } from "vitest";
import {
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
});
