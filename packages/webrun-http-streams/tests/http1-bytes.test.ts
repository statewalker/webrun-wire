import { describe, expect, it, vi } from "vitest";
import { ByteReader, ByteStreamError } from "../src/bytes.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("ByteReader", () => {
  it("reads CRLF-terminated lines, excluding the CRLF", async () => {
    const r = new ByteReader([enc("GET / HTTP/1.1\r\nHost: x\r\n\r\nbody")]);
    expect(dec(await r.readLine(1024))).toBe("GET / HTTP/1.1");
    expect(dec(await r.readLine(1024))).toBe("Host: x");
    expect((await r.readLine(1024)).byteLength).toBe(0);
    expect(dec((await r.readSome(64)) as Uint8Array)).toBe("body");
  });

  it("joins a line split across chunks, including a CR/LF split", async () => {
    const r = new ByteReader([enc("Host: exa"), enc("mple.test\r"), enc("\nrest")]);
    expect(dec(await r.readLine(1024))).toBe("Host: example.test");
    expect(dec((await r.readSome(64)) as Uint8Array)).toBe("rest");
  });

  it("rejects a bare LF", async () => {
    const r = new ByteReader([enc("GET / HTTP/1.1\nHost: x\r\n")]);
    await expect(r.readLine(1024)).rejects.toThrow(/bare LF/);
  });

  it("rejects a line longer than the bound", async () => {
    const r = new ByteReader([enc("x".repeat(50))]);
    await expect(r.readLine(16)).rejects.toThrow(/without CRLF/);
  });

  it("throws when the stream ends mid-line", async () => {
    const r = new ByteReader([enc("no terminator")]);
    await expect(r.readLine(1024)).rejects.toThrow(ByteStreamError);
  });

  it("readSome never returns more than asked and reports EOF as undefined", async () => {
    const r = new ByteReader([enc("abcdef")]);
    expect(dec((await r.readSome(2)) as Uint8Array)).toBe("ab");
    expect(dec((await r.readSome(99)) as Uint8Array)).toBe("cdef");
    expect(await r.readSome(1)).toBeUndefined();
  });

  it("peekByte does not consume, and bufferedLength reports what is pending", async () => {
    const r = new ByteReader([enc("GET")]);
    expect(await r.peekByte()).toBe(0x47);
    expect(r.bufferedLength()).toBe(3);
    expect(dec((await r.readSome(3)) as Uint8Array)).toBe("GET");
    expect(r.bufferedLength()).toBe(0);
  });

  it("skips empty chunks and streams the rest lazily", async () => {
    const r = new ByteReader([enc("a"), enc(""), enc("b")]);
    const seen: string[] = [];
    for await (const chunk of r.rest()) seen.push(dec(chunk));
    expect(seen.join("")).toBe("ab");
  });
});

describe("ByteReader.readLine is linear in the line length (#144)", () => {
  it("joins a 64,000-byte line sent one byte per chunk, copying each byte a bounded number of times", async () => {
    const n = 64_000;
    const text = `${"a".repeat(n)}\r\nrest`;
    const chunks = [...enc(text)].map((b) => new Uint8Array([b]));
    const r = new ByteReader(chunks);

    // A buffer concatenated on every pull copies ~n²/2 bytes (2 GB here); one join per line
    // copies each byte once.
    let copied = 0;
    const original = Uint8Array.prototype.set;
    const spy = vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ) {
      copied += source.length;
      return original.call(this, source, offset);
    });
    let line: Uint8Array;
    try {
      line = await r.readLine(n + 10);
    } finally {
      spy.mockRestore();
    }
    expect(line.byteLength).toBe(n);
    expect(line.every((b) => b === 0x61)).toBe(true);
    expect(copied).toBeLessThanOrEqual(2 * (n + 2));
    expect(dec((await r.readSome(64)) as Uint8Array)).toBe("r");
  });

  it("still enforces the bound and reports a stream that ends without CRLF", async () => {
    const one = (s: string) => [...enc(s)].map((b) => new Uint8Array([b]));
    await expect(new ByteReader(one("x".repeat(50))).readLine(16)).rejects.toThrow(
      /exceeds 16 bytes/,
    );
    await expect(new ByteReader(one("abc")).readLine(16)).rejects.toThrow(
      /ended after 3 bytes without CRLF/,
    );
    await expect(new ByteReader(one("ab\nc")).readLine(16)).rejects.toThrow(/bare LF/);
  });
});
