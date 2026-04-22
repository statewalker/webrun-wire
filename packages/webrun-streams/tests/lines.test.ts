import { describe, expect, it } from "vitest";
import { collect } from "../src/collect.js";
import { joinLines, splitLines } from "../src/lines.js";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("splitLines", () => {
  it("splits on newlines", async () => {
    const result = await collect(splitLines(from(["a\nb\nc"])));
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("handles lines split across chunks", async () => {
    const result = await collect(splitLines(from(["hel", "lo\nwor", "ld"])));
    expect(result).toEqual(["hello", "world"]);
  });

  it("handles trailing content without newline", async () => {
    const result = await collect(splitLines(from(["a\nb"])));
    expect(result).toEqual(["a", "b"]);
  });

  it("handles empty lines", async () => {
    const result = await collect(splitLines(from(["a\n\nb"])));
    expect(result).toEqual(["a", "", "b"]);
  });

  it("handles empty stream", async () => {
    const result = await collect(splitLines(from([])));
    expect(result).toEqual([]);
  });
});

describe("joinLines", () => {
  it("appends newline to each string", async () => {
    const result = await collect(joinLines(from(["a", "b", "c"])));
    expect(result).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("handles empty stream", async () => {
    const result = await collect(joinLines(from([])));
    expect(result).toEqual([]);
  });
});

describe("splitLines + joinLines round-trip", () => {
  it("round-trips lines", async () => {
    const original = ["hello", "world", "test"];
    const result = await collect(splitLines(joinLines(from(original))));
    expect(result).toEqual(original);
  });
});
