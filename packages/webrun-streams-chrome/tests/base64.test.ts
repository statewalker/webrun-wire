import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../src/index.js";

describe("base64", () => {
  it("round-trips every byte value and sizes across the 32 KiB slice", () => {
    for (const size of [0, 1, 2, 3, 255, 32 * 1024, 32 * 1024 + 1, 100_000]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 7) & 0xff);
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64"));
      expect(base64ToBytes(text)).toEqual(bytes);
    }
  });

  it("encodes a view, not its whole buffer", () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5]);
    expect(bytesToBase64(buffer.subarray(1, 3))).toBe(Buffer.from([2, 3]).toString("base64"));
  });
});
