import { describe, expect, it } from "vitest";
import { collect, collectString } from "../src/collect.js";
import { decodeJsonl, encodeJsonl } from "../src/jsonl.js";
import { encodeText } from "../src/text.js";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("JSONL", () => {
  it("encodes objects as JSON lines", async () => {
    const result = await collectString(encodeJsonl(from([{ a: 1 }, { b: 2 }])));
    expect(result).toBe('{"a":1}\n{"b":2}\n');
  });

  it("decodes JSON lines to objects", async () => {
    const result = await collect(decodeJsonl<{ a: number }>(from(['{"a":1}\n{"a":2}\n'])));
    expect(result).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("round-trips through encode + decode", async () => {
    const original = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const encoded = encodeJsonl(from(original));
    const decoded = await collect(decodeJsonl(encoded));
    expect(decoded).toEqual(original);
  });

  it("composes with encodeText + splitLines", async () => {
    const objects = [{ x: 1 }, { x: 2 }];
    const jsonlStrings = encodeJsonl(from(objects));
    const bytes = encodeText(jsonlStrings);
    // Simulate reading back
    const { decodeText } = await import("../src/text.js");
    const strings = decodeText(bytes);
    const decoded = await collect(decodeJsonl(strings));
    expect(decoded).toEqual(objects);
  });

  it("skips empty lines", async () => {
    const result = await collect(decodeJsonl<number>(from(["1\n\n2\n"])));
    expect(result).toEqual([1, 2]);
  });

  it("handles arrays and primitives", async () => {
    const original = [[1, 2], "hello", 42, null, true];
    const result = await collect(decodeJsonl(encodeJsonl(from(original))));
    expect(result).toEqual(original);
  });
});
