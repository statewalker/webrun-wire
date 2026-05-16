import { describe, expect, it } from "vitest";
import { normalizeToUint8Array } from "../src/index.js";

describe("normalizeToUint8Array", () => {
  it("returns Uint8Array unchanged", () => {
    const u = new Uint8Array([1, 2, 3]);
    expect(normalizeToUint8Array(u)).toBe(u);
  });

  it("wraps ArrayBuffer", () => {
    const ab = new Uint8Array([7, 8, 9]).buffer;
    const out = normalizeToUint8Array(ab) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([7, 8, 9]);
  });

  it("wraps a typed-array view (subarray)", () => {
    const u = new Uint16Array([0x4241]); // little-endian: "AB"
    const out = normalizeToUint8Array(u) as Uint8Array;
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(2);
  });

  it("encodes string as UTF-8", () => {
    const out = normalizeToUint8Array("ab") as Uint8Array;
    expect(Array.from(out)).toEqual([0x61, 0x62]);
  });

  it("handles Blob asynchronously", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const out = await normalizeToUint8Array(blob);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("throws TypeError on unsupported input", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing rejection of bad input
    expect(() => normalizeToUint8Array(null as any)).toThrow(TypeError);
    // biome-ignore lint/suspicious/noExplicitAny: testing rejection of bad input
    expect(() => normalizeToUint8Array(42 as any)).toThrow(TypeError);
    // biome-ignore lint/suspicious/noExplicitAny: testing rejection of bad input
    expect(() => normalizeToUint8Array({ a: 1 } as any)).toThrow(TypeError);
  });
});
