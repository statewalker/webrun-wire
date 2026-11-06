import { describe, expect, it } from "vitest";
import { connect, overPipe, serve, structuredCodec } from "../src/index.js";

// A caller that leaves reaches the handler's output at once — its `return()` —
// even while the handler is still working on its first chunk, with or without
// `maxMessageSize` (whose chunking wraps the output in a generator of its own).

/** A handler output that never yields, and records when `return()` reaches it. */
function parked() {
  const state = { returned: false };
  const output: AsyncGenerator<Uint8Array> = {
    next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
    return: async (value) => {
      state.returned = true;
      return { done: true, value };
    },
    throw: async (error) => {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return output;
    },
    [Symbol.asyncDispose]: async () => {},
  };
  return { state, output };
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  return predicate();
}

describe("serve forwards a caller's departure at once", () => {
  for (const maxMessageSize of [undefined, 16 * 1024]) {
    it(`to a handler still working on its first chunk (maxMessageSize ${maxMessageSize})`, async () => {
      const channel = new MessageChannel();
      const { state, output } = parked();
      let called = false;
      const stop = await serve(
        {
          mux: overPipe(channel.port2, {
            codec: structuredCodec,
            side: "responder",
            maxMessageSize,
          }),
        },
        () => {
          called = true;
          return output;
        },
      );
      const client = await connect({
        mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator", maxMessageSize }),
      });
      try {
        const it = client.call([new Uint8Array([1])])[Symbol.asyncIterator]();
        const pending = it.next().catch(() => undefined);
        expect(await until(() => called)).toBe(true);
        await it.return?.(undefined);
        await pending;
        expect(await until(() => state.returned)).toBe(true);
      } finally {
        await client.close();
        await stop();
        channel.port1.close();
        channel.port2.close();
      }
    });
  }
});
