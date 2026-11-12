import type { MessageListener, MessageTarget } from "@statewalker/webrun-rpc";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { msgpackCodec } from "../src/index.js";

/** Two byte pipes back to back that record the largest message posted. */
function recordingPipePair() {
  const listeners: [Set<MessageListener>, Set<MessageListener>] = [new Set(), new Set()];
  const stats = { largest: 0 };
  const make = (self: 0 | 1): MessageTarget => ({
    postMessage(message: unknown) {
      const bytes = message as Uint8Array;
      stats.largest = Math.max(stats.largest, bytes.byteLength);
      const copy = bytes.slice();
      setTimeout(() => {
        for (const l of [...listeners[(1 - self) as 0 | 1]])
          void l(new MessageEvent("message", { data: copy }));
      }, 0);
    },
    addEventListener: (_t, l) => void listeners[self].add(l),
    removeEventListener: (_t, l) => void listeners[self].delete(l),
  });
  return { a: make(0), b: make(1), stats };
}

describe("an error crosses within maxMessageSize (review of #106)", () => {
  for (const [name, error] of [
    ["a 20,000-character message", new Error("x".repeat(20_000))],
    ["a 17 KB field", Object.assign(new Error("http 500"), { body: "b".repeat(17_000) })],
  ] as const) {
    it(`${name}: every frame stays under maxMessageSize + 256, and the caller gets the error`, async () => {
      const { a, b, stats } = recordingPipePair();
      const maxMessageSize = 4096;
      await serve(
        { mux: overPipe(b, { codec: msgpackCodec, side: "responder", maxMessageSize }) },
        (input) =>
          (async function* () {
            for await (const _ of input);
            yield new Uint8Array(0);
            throw error;
          })(),
      );
      const { call, close } = await connect({
        mux: overPipe(a, { codec: msgpackCodec, side: "initiator", maxMessageSize }),
      });
      const failure = await collectBytes(call((async function* () {})())).catch((e) => e);
      await close();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message.startsWith(error.message.slice(0, 8))).toBe(true);
      expect(stats.largest).toBeLessThanOrEqual(maxMessageSize + 256);
    });
  }
});
