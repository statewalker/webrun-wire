import { describe, expect, it } from "vitest";
import { decodeUint32, encodeUint32 } from "../src/uint32.js";

describe("uint32 credit payloads", () => {
  it("round-trips a value", () => {
    const bytes = encodeUint32(8 * 1024 * 1024);
    expect(bytes.byteLength).toBe(4);
    expect(decodeUint32(bytes)).toBe(8 * 1024 * 1024);
  });

  it("round-trips zero and the maximum", () => {
    expect(decodeUint32(encodeUint32(0))).toBe(0);
    expect(decodeUint32(encodeUint32(0xffffffff))).toBe(0xffffffff);
  });

  it("clamps at the ceiling instead of wrapping to zero", () => {
    // `n >>> 0` makes each of these a different, smaller number: 0, 0 and 5.
    // The first two advertise no credit at all and hang the peer permanently.
    expect(decodeUint32(encodeUint32(2 ** 32))).toBe(0xffffffff);
    expect(decodeUint32(encodeUint32(8 * 1024 * 1024 * 1024))).toBe(0xffffffff);
    expect(decodeUint32(encodeUint32(2 ** 32 + 5))).toBe(0xffffffff);
  });

  it("clamps a negative, fractional or non-finite value into range", () => {
    expect(decodeUint32(encodeUint32(-1))).toBe(0);
    expect(decodeUint32(encodeUint32(1.9))).toBe(1);
    expect(decodeUint32(encodeUint32(Number.NaN))).toBe(0);
  });

  it("returns undefined for a payload shorter than four bytes", () => {
    expect(decodeUint32(new Uint8Array(0))).toBeUndefined();
    expect(decodeUint32(new Uint8Array(3))).toBeUndefined();
  });

  it("reads the first four bytes when the payload is longer", () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 12345, false);
    expect(decodeUint32(bytes)).toBe(12345);
  });

  it("reads through a non-zero byteOffset", () => {
    const backing = new Uint8Array(8);
    new DataView(backing.buffer).setUint32(4, 999, false);
    expect(decodeUint32(backing.subarray(4))).toBe(999);
  });
});
