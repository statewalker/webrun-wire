import { describe, expect, it } from "vitest";
import { collectBytes, toChunks } from "../src/index.js";

describe("toChunks", () => {
  it("splits oversize chunks", async () => {
    const chunk = new Uint8Array(100_000).fill(7);
    const pieces: number[] = [];
    for await (const piece of toChunks(32_768)([chunk])) {
      pieces.push(piece.byteLength);
    }
    expect(pieces).toEqual([32_768, 32_768, 32_768, 1_696]);
    expect(pieces.reduce((a, b) => a + b)).toBe(100_000);
  });

  it("passes small chunks through unchanged", async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const out: Uint8Array[] = [];
    for await (const piece of toChunks(16_384)([a, b])) {
      out.push(piece);
    }
    expect(out).toEqual([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("skips empty chunks", async () => {
    const out = await collectBytes(
      toChunks(1024)([new Uint8Array(0), new Uint8Array([1, 2]), new Uint8Array(0)]),
    );
    expect(out).toEqual(new Uint8Array([1, 2]));
  });

  it("preserves byte order and total length over many chunks", async () => {
    const source = new Uint8Array(1_000);
    for (let i = 0; i < source.length; i++) source[i] = i & 0xff;
    const out = await collectBytes(toChunks(73)([source]));
    expect(out).toEqual(source);
  });

  it("rejects non-positive size", () => {
    expect(() => toChunks(0)).toThrow(RangeError);
    expect(() => toChunks(-1)).toThrow(RangeError);
    expect(() => toChunks(1.5)).toThrow(RangeError);
  });
});
