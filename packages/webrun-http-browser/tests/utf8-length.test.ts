import { describe, expect, it } from "vitest";
import { messageSize, utf8Length } from "../src/ws/frames.js";

const encoded = (text: string) => new TextEncoder().encode(text).length;

describe("utf8Length", () => {
  it("counts as TextEncoder encodes: 1, 2, 3 and 4 byte characters", () => {
    for (const text of ["", "a", "é", "€", "😀", "aé€😀", "hello again ✓"])
      expect(utf8Length(text)).toBe(encoded(text));
  });

  it("counts a lone surrogate as U+FFFD (3 bytes)", () => {
    for (const text of ["\ud83d", "\ude00", "a\ud83db", "\ude00\ud83d", "x\ud83d"])
      expect(utf8Length(text)).toBe(encoded(text));
  });

  it("counts long strings, whatever falls on a chunk boundary", () => {
    const pair = "😀"; // two UTF-16 code units
    for (const n of [32_767, 32_768, 32_769, 65_535, 65_536, 100_001]) {
      expect(utf8Length("x".repeat(n))).toBe(n);
      // A surrogate pair across each chunk boundary, and lone halves at the end.
      const text = `${"x".repeat(n - 1)}${pair}${"é".repeat(n)}\ud83d`;
      expect(utf8Length(text)).toBe(encoded(text));
      const lone = `${"x".repeat(n - 1)}\ud83d${"€".repeat(n)}`;
      expect(utf8Length(lone)).toBe(encoded(lone));
    }
  });

  it("messageSize: UTF-8 bytes of a string, the length of a buffer", () => {
    expect(messageSize("é€")).toBe(5);
    expect(messageSize(new ArrayBuffer(7))).toBe(7);
  });
});
