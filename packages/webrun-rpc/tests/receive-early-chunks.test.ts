import { describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";

// statewalker/webrun-wire#123: a chunk that reached the receiving side before
// the handler started reading its input was acknowledged and dropped.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

describe("receive: chunks that arrive before the handler reads its input", () => {
  for (const delay of [0, 15, 50]) {
    it(`delivers every chunk and ends normally when the handler waits ${delay} ms`, async () => {
      const { port1, port2 } = newChannel();
      const close = listenBidi<number, number>(port2, async (input) => {
        await sleep(delay); // async setup before the handler pulls its input
        return (async function* () {
          for await (const v of input) yield v;
        })();
      });
      try {
        const input = (async function* () {
          for (let i = 1; i <= 3; i++) {
            yield i;
            await sleep(10);
          }
        })();
        const got: number[] = [];
        for await (const v of callBidi<number, number>(port1, input)) got.push(v);
        expect(got).toEqual([1, 2, 3]);
      } finally {
        close();
        port1.close();
        port2.close();
      }
    }, 3000);
  }
});
