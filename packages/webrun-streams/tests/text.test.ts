import { describe, expect, it } from "vitest";
import { collectBytes, collectString } from "../src/collect.js";
import { decodeText, encodeText } from "../src/text.js";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("decodeText", () => {
  it("decodes ASCII bytes to string", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const decoded = await collectString(decodeText(from([bytes])));
    expect(decoded).toBe("hello world");
  });

  it("handles multi-byte UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("日本");
    const chunk1 = bytes.slice(0, 4);
    const chunk2 = bytes.slice(4);
    const decoded = await collectString(decodeText(from([chunk1, chunk2])));
    expect(decoded).toBe("日本");
  });

  it("handles emoji split across chunks", async () => {
    const bytes = new TextEncoder().encode("🎉");
    const chunk1 = bytes.slice(0, 2);
    const chunk2 = bytes.slice(2);
    const decoded = await collectString(decodeText(from([chunk1, chunk2])));
    expect(decoded).toBe("🎉");
  });

  it("handles empty stream", async () => {
    const decoded = await collectString(decodeText(from([])));
    expect(decoded).toBe("");
  });
});

describe("encodeText", () => {
  it("encodes string to UTF-8 bytes", async () => {
    const bytes = await collectBytes(encodeText(from(["café"])));
    expect(new TextDecoder().decode(bytes)).toBe("café");
  });

  it("handles empty strings", async () => {
    const bytes = await collectBytes(encodeText(from([""])));
    expect(bytes.length).toBe(0);
  });
});

describe("decodeText + encodeText round-trip", () => {
  it("round-trips ASCII", async () => {
    const text = "hello world";
    const decoded = await collectString(decodeText(encodeText(from([text]))));
    expect(decoded).toBe(text);
  });

  it("round-trips Unicode", async () => {
    const text = "日本語テスト 🎉";
    const decoded = await collectString(decodeText(encodeText(from([text]))));
    expect(decoded).toBe(text);
  });
});
