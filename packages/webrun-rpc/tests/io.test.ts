import { describe, expect, it } from "vitest";
import { ioHandle } from "../src/io-handle.js";
import { ioSend } from "../src/io-send.js";

async function* makeAsync<T>(items: Iterable<T>, maxTimeout = 20): AsyncGenerator<T> {
  for (const value of items) {
    await new Promise((r) => setTimeout(r, Math.random() * maxTimeout));
    yield value;
  }
}

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

describe("ioSend / ioHandle", () => {
  async function run<T>(input: AsyncIterable<T> | Iterable<T>, control: string[]) {
    const controller = new AbortController();
    try {
      const { port1, port2 } = newChannel();
      const options = { channelName: "test" };
      const calls: number[] = [];

      void (async () => {
        async function* handler(inp: AsyncIterable<T>) {
          for await (const value of inp) {
            yield String(value).toUpperCase();
          }
        }
        for await (const callId of ioHandle<T, string>(port2, handler, options)) {
          if (controller.signal.aborted) break;
          calls.push(callId);
        }
      })();

      const values: string[] = [];
      for await (const value of ioSend<string, T>(port1, input, options)) {
        values.push(value);
      }
      expect(values).toEqual(control);
    } finally {
      controller.abort();
    }
  }

  it("uppercases sync inputs", () => run(["a", "b", "c"], ["A", "B", "C"]));
  it("uppercases async inputs", () => run(makeAsync(["a", "b", "c"]), ["A", "B", "C"]));
  it("passes an empty input through cleanly", () => run([] as string[], [] as string[]));
});
