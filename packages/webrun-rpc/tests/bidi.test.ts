import { describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

describe("callBidi / listenBidi", () => {
  it("roundtrips a stream and passes params through", async () => {
    const { port1, port2 } = newChannel();
    let seenParams: Record<string, unknown> | undefined;
    const close = listenBidi<string, string>(port1, async function* (input, p) {
      seenParams = p;
      for await (const value of input) yield value.toUpperCase();
    });
    try {
      const values: string[] = [];
      for await (const v of callBidi<string, string>(port2, ["Hello", "World"], { foo: "Bar" })) {
        values.push(v);
      }
      expect(values).toEqual(["HELLO", "WORLD"]);
      expect(seenParams).toBeTypeOf("object");
      const { channelName, ...rest } = seenParams as Record<string, unknown>;
      expect(typeof channelName).toBe("string");
      expect(channelName).not.toBe("");
      expect(rest).toEqual({ foo: "Bar" });
    } finally {
      close();
    }
  });

  it("handles an empty input stream", async () => {
    const { port1, port2 } = newChannel();
    const close = listenBidi<number, number>(port1, async function* double(input) {
      for await (const v of input) yield v * 2;
    });
    try {
      const got: number[] = [];
      for await (const v of callBidi<number, number>(port2, [])) got.push(v);
      expect(got).toEqual([]);
    } finally {
      close();
    }
  });

  it("accept predicate receives the announced params", async () => {
    const { port1, port2 } = newChannel();
    const seen: Array<Record<string, unknown>> = [];
    const close = listenBidi<string, string>(
      port1,
      async function* passthrough(input) {
        for await (const v of input) yield v;
      },
      (params) => {
        seen.push({ ...params });
        return true;
      },
    );
    try {
      const drained: string[] = [];
      for await (const v of callBidi<string, string>(port2, ["a"], { tag: "T" })) {
        drained.push(v);
      }
      expect(drained).toEqual(["a"]);
      expect(seen.length).toBe(1);
      expect(seen[0].tag).toBe("T");
      expect(typeof seen[0].channelName).toBe("string");
    } finally {
      close();
    }
  });
});
