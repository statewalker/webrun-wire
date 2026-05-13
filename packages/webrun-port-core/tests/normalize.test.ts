import { describe, expect, it } from "vitest";
import { normalizeToUint8Array } from "../src/normalize.js";

describe("normalizeToUint8Array", () => {
  it("returns Uint8Array as-is", () => {
    const input = new Uint8Array([1, 2, 3]);
    expect(normalizeToUint8Array(input)).toBe(input);
  });

  it("converts ArrayBuffer", () => {
    const buf = new Uint8Array([7, 8, 9]).buffer;
    const out = normalizeToUint8Array(buf);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([7, 8, 9]);
  });

  it("converts ArrayBufferView (DataView)", () => {
    const view = new DataView(new Uint8Array([4, 5, 6]).buffer);
    const out = normalizeToUint8Array(view);
    expect(Array.from(out as Uint8Array)).toEqual([4, 5, 6]);
  });

  it("converts ArrayBufferView (Int16Array)", () => {
    const view = new Int16Array([0x0201]);
    const out = normalizeToUint8Array(view);
    expect((out as Uint8Array).byteLength).toBe(2);
  });

  it("converts string to UTF-8", () => {
    const out = normalizeToUint8Array("hi");
    expect(Array.from(out as Uint8Array)).toEqual([0x68, 0x69]);
  });

  it("converts Blob to Uint8Array (async)", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const out = await normalizeToUint8Array(blob);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("throws TypeError on null", () => {
    expect(() => normalizeToUint8Array(null as never)).toThrow(TypeError);
  });

  it("throws TypeError on number", () => {
    expect(() => normalizeToUint8Array(42 as never)).toThrow(TypeError);
  });

  it("throws TypeError on plain object", () => {
    expect(() => normalizeToUint8Array({ a: 1 } as never)).toThrow(TypeError);
  });
});
