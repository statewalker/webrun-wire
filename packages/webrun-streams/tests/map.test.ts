import { describe, expect, it } from "vitest";
import { collect } from "../src/collect.js";
import { map } from "../src/map.js";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("map", () => {
  it("applies sync function", async () => {
    const result = await collect(map(from([1, 2, 3]), (x) => x * 2));
    expect(result).toEqual([2, 4, 6]);
  });

  it("applies async function", async () => {
    const result = await collect(map(from(["a", "b"]), async (x) => x.toUpperCase()));
    expect(result).toEqual(["A", "B"]);
  });

  it("handles empty stream", async () => {
    const result = await collect(map(from([]), (x) => x));
    expect(result).toEqual([]);
  });

  it("preserves order", async () => {
    const result = await collect(map(from([3, 1, 2]), (x) => x.toString()));
    expect(result).toEqual(["3", "1", "2"]);
  });
});
