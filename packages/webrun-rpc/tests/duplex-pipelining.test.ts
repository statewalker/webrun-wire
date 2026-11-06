import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// Streams on a port whose window both ends speak are pipelined: chunks leave
// without a confirmation each, and only the window holds the sender back. What
// a stream delivers, and how its errors look, must not change.

const KiB = 1024;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * `connect` / `serve` over one `MessageChannel`, with `window` on both ends
 * (or none). `responses` counts the chunk confirmations each side sends
 * back, read off the raw pipe: the caller's for the handler's output (`out`),
 * the handler's for the caller's input (`in`).
 */
async function link(window: number | undefined, handler: Duplex) {
  const ch = new MessageChannel();
  const responses = { in: 0, out: 0 };
  const count = (channelName: "in" | "out") => (event: MessageEvent) => {
    const payload = (event.data as { payload?: { type?: string; channelName?: string } }).payload;
    if (payload?.type === "response:result" && payload.channelName === channelName) {
      responses[channelName]++;
    }
  };
  ch.port2.addEventListener("message", count("out"));
  ch.port1.addEventListener("message", count("in"));
  const teardown = await serve(
    { mux: overPipe(ch.port2, { codec: structuredCodec, side: "responder", window }) },
    handler,
  );
  const { call, close } = await connect({
    mux: overPipe(ch.port1, { codec: structuredCodec, side: "initiator", window }),
  });
  cleanups.push(async () => {
    await close();
    await teardown();
    ch.port1.close();
    ch.port2.close();
  });
  return { call, responses };
}

/** Reads a stream to its end: the chunks' bytes, and the error it ended with. */
async function drain(stream: AsyncIterable<Uint8Array>) {
  const seen: number[] = [];
  let error: unknown;
  try {
    for await (const chunk of stream) seen.push(...chunk);
  } catch (err) {
    error = err;
  }
  return { seen, error };
}

describe("duplexOverPort — pipelined chunks under a window", () => {
  it("a handler's error reaches the caller identically with and without pipelining", async () => {
    class BoomError extends Error {
      override name = "BoomError";
    }
    const failing: Duplex = async function* (input) {
      for await (const _ of input) {
      }
      for (let i = 0; i < 20; i++) yield new Uint8Array([i]);
      throw new BoomError("boom after 20 chunks");
    };
    const plain = await drain((await link(undefined, failing)).call([new Uint8Array([1])]));
    const piped = await drain((await link(64 * KiB, failing)).call([new Uint8Array([1])]));

    expect(plain.seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(piped.seen).toEqual(plain.seen);
    expect((plain.error as Error).message).toBe("boom after 20 chunks");
    expect((piped.error as Error).message).toBe((plain.error as Error).message);
    expect((piped.error as Error).name).toBe((plain.error as Error).name);
  });

  it("agreed pipelining sends no acknowledgement per chunk, in either direction", async () => {
    const CHUNKS = 200;
    const echo: Duplex = async function* (input) {
      for await (const chunk of input) yield chunk;
    };
    const input = Array.from({ length: CHUNKS }, (_, i) => new Uint8Array(256).fill(i & 0xff));
    const plain = await link(undefined, echo);
    const piped = await link(64 * KiB, echo);

    expect((await drain(plain.call(input))).seen).toHaveLength(CHUNKS * 256);
    expect((await drain(piped.call(input))).seen).toHaveLength(CHUNKS * 256);
    // Without a window every chunk, and the end, is confirmed.
    expect(plain.responses).toEqual({ in: CHUNKS + 1, out: CHUNKS + 1 });
    // Until the handshake settles, the first chunk each way may still go
    // confirmed: the caller's leaves with the `open`, before the ack, and the
    // handler's answer to it before the opener's answer to the ack arrives.
    expect(piped.responses.in).toBeLessThanOrEqual(1);
    expect(piped.responses.out).toBeLessThanOrEqual(1);
  });

  it("carries a large body both ways, in order, through a small window", async () => {
    const echo: Duplex = async function* (input) {
      for await (const chunk of input) yield chunk;
    };
    const { call } = await link(4 * KiB, echo);
    const input = Array.from({ length: 300 }, (_, i) => new Uint8Array(1000).fill(i & 0xff));
    const { seen, error } = await drain(call(input));
    expect(error).toBeUndefined();
    expect(seen).toEqual(input.flatMap((c) => [...c]));
  });
});
