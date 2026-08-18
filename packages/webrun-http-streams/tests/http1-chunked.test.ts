import { describe, expect, it } from "vitest";
import { ByteReader } from "../src/bytes.js";
import { decodeChunked, encodeChunked } from "../src/http1/chunked.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function wire(body: Uint8Array[]): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of encodeChunked(body)) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

async function unwire(text: string): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of decodeChunked(new ByteReader([enc(text)]), 1024)) {
    out += dec.decode(chunk, { stream: true });
  }
  return out + dec.decode();
}

describe("encodeChunked", () => {
  it("writes chunk sizes in HEXADECIMAL, not decimal", async () => {
    // 21 bytes. Decimal would write "21", which a conforming parser reads as
    // 0x21 = 33 bytes. This is note 15's third @libp2p/http defect and the one
    // no parser can catch downstream, because "21" is also valid hex.
    const twentyOne = enc("a".repeat(21));
    expect(twentyOne.byteLength).toBe(21);
    expect(await wire([twentyOne])).toBe(`15\r\n${"a".repeat(21)}\r\n0\r\n\r\n`);
  });

  it("emits one framed chunk per source chunk and a terminator", async () => {
    expect(await wire([enc("ab"), enc("cde")])).toBe("2\r\nab\r\n3\r\ncde\r\n0\r\n\r\n");
  });

  it("skips zero-length chunks, which would terminate the body early", async () => {
    expect(await wire([enc("ab"), enc(""), enc("cd")])).toBe("2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n");
  });

  it("emits a bare terminator for an empty body", async () => {
    expect(await wire([])).toBe("0\r\n\r\n");
  });
});

describe("decodeChunked", () => {
  it("round-trips what encodeChunked produced", async () => {
    expect(await unwire(await wire([enc("hello "), enc("world")]))).toBe("hello world");
  });

  it("accepts and ignores chunk extensions", async () => {
    expect(await unwire("5;name=value\r\nhello\r\n0\r\n\r\n")).toBe("hello");
  });

  it("accepts and discards a trailer section", async () => {
    expect(await unwire("2\r\nhi\r\n0\r\nX-Trailer: yes\r\n\r\n")).toBe("hi");
  });

  it("reads uppercase hex sizes", async () => {
    expect(await unwire(`A\r\n${"z".repeat(10)}\r\n0\r\n\r\n`)).toBe("z".repeat(10));
  });

  it("rejects a non-hex chunk size", async () => {
    await expect(unwire("1z\r\nhello\r\n0\r\n\r\n")).rejects.toThrow(/invalid chunk size/);
  });

  it("rejects chunk data not terminated by CRLF", async () => {
    await expect(unwire("2\r\nhiXX0\r\n\r\n")).rejects.toThrow(/not terminated by CRLF/);
  });

  it("rejects a truncated chunk", async () => {
    await expect(unwire("10\r\nshort")).rejects.toThrow(/truncated|without CRLF/);
  });
});
