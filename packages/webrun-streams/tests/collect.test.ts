import { describe, expect, it } from "vitest";
import { collect, collectBytes, collectString } from "../src/collect.js";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("collect", () => {
  it("gathers items into array", async () => {
    expect(await collect(from([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("handles empty stream", async () => {
    expect(await collect(from([]))).toEqual([]);
  });
});

describe("collectBytes", () => {
  it("concatenates chunks", async () => {
    const result = await collectBytes(from([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
  });

  it("returns same reference for single chunk (no copy)", async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const result = await collectBytes(from([chunk]));
    expect(result).toBe(chunk);
  });

  it("handles empty stream", async () => {
    const result = await collectBytes(from([]));
    expect(result.length).toBe(0);
  });
});

describe("collectString", () => {
  it("concatenates strings", async () => {
    expect(await collectString(from(["hello", " ", "world"]))).toBe("hello world");
  });

  it("handles empty stream", async () => {
    expect(await collectString(from([]))).toBe("");
  });
});
