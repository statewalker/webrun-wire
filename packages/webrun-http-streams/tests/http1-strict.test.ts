import { describe, expect, it } from "vitest";
import { decodeRequest } from "../src/http1/decode.js";
import type { ResolvedHttpCodecOptions } from "../src/http1/encode.js";
import { HttpParseError } from "../src/http1/errors.js";

const BASE: ResolvedHttpCodecOptions = {
  scheme: "http",
  host: "fallback.test",
  maxHeaderBytes: 65536,
};
const enc = (s: string) => new TextEncoder().encode(s);

/** Decode and fully drain, so errors raised while reading the body surface too. */
async function parse(wire: string, maxHeaderBytes = 65536): Promise<void> {
  const { body } = await decodeRequest([enc(wire)], { ...BASE, maxHeaderBytes });
  for await (const _chunk of body) {
    /* drain */
  }
}

const HEAD = "POST /x HTTP/1.1\r\nHost: h.test\r\n";

const CORPUS: { name: string; wire: string; pattern: RegExp; maxHeaderBytes?: number }[] = [
  {
    name: "Content-Length and Transfer-Encoding together (request smuggling)",
    wire: `${HEAD}Content-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    pattern: /smuggling/,
  },
  {
    name: "conflicting duplicate Content-Length",
    wire: `${HEAD}Content-Length: 5\r\nContent-Length: 6\r\n\r\nhello`,
    pattern: /conflicting Content-Length/,
  },
  {
    name: "non-numeric Content-Length",
    wire: `${HEAD}Content-Length: abc\r\n\r\n`,
    pattern: /invalid Content-Length/,
  },
  {
    name: "non-hex chunk size",
    wire: `${HEAD}Transfer-Encoding: chunked\r\n\r\n1z\r\nhello\r\n0\r\n\r\n`,
    pattern: /invalid chunk size/,
  },
  {
    name: "chunk data not terminated by CRLF",
    wire: `${HEAD}Transfer-Encoding: chunked\r\n\r\n2\r\nhiXX0\r\n\r\n`,
    pattern: /not terminated by CRLF/,
  },
  {
    name: "head section over the byte bound",
    wire: `${HEAD}X-Big: ${"a".repeat(500)}\r\n\r\n`,
    pattern: /exceeds 128 bytes|without CRLF/,
    maxHeaderBytes: 128,
  },
  {
    name: "obs-fold header continuation",
    wire: `${HEAD}X-Folded: one\r\n\ttwo\r\n\r\n`,
    pattern: /obs-fold/,
  },
  {
    name: "bare LF line terminator",
    wire: "POST /x HTTP/1.1\nHost: h.test\r\n\r\n",
    pattern: /bare LF/,
  },
  {
    name: "space inside a header name",
    wire: `${HEAD}Bad Header: x\r\n\r\n`,
    pattern: /invalid header name/,
  },
  {
    name: "control character in a header value",
    wire: `${HEAD}X-Ctl: a\x01b\r\n\r\n`,
    pattern: /control character/,
  },
  {
    name: "CR embedded in a header value",
    wire: `${HEAD}X-Foo: a\rb\r\n\r\n`,
    pattern: /value contains CR or LF/,
  },
  {
    name: "HTTP/1.1 request with no Host",
    wire: "POST /x HTTP/1.1\r\nContent-Length: 0\r\n\r\n",
    pattern: /no Host header/,
  },
  {
    name: "body truncated against its Content-Length",
    wire: `${HEAD}Content-Length: 10\r\n\r\nshort`,
    pattern: /body truncated/,
  },
  {
    name: "Transfer-Encoding whose final coding is not chunked",
    wire: `${HEAD}Transfer-Encoding: gzip\r\n\r\n`,
    pattern: /unsupported Transfer-Encoding/,
  },
  {
    name: "trailing bytes after a complete message",
    wire: `${HEAD}Content-Length: 2\r\n\r\nhiGET /second HTTP/1.1\r\nHost: h.test\r\n\r\n`,
    pattern: /trailing bytes after a complete message/,
  },
  {
    name: "multiple Host headers",
    wire: "POST /x HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n",
    pattern: /multiple Host headers/,
  },
  {
    name: "request line with an extra space",
    wire: "POST /a b HTTP/1.1\r\nHost: h.test\r\n\r\n",
    pattern: /malformed request line/,
  },
  {
    name: "trailing bytes after a bodyless request (pipelined second request)",
    wire: "GET /x HTTP/1.1\r\nHost: h.test\r\n\r\nGET /second HTTP/1.1\r\nHost: h.test\r\n\r\n",
    pattern: /trailing bytes after a complete message/,
  },
  {
    // RFC 9112 §2.2 permits a recipient to tolerate one leading CRLF before
    // the request-line ("SHOULD ignore"). This codec's strict posture
    // declines that leniency — see README.md and ADR-0006.
    name: "leading CRLF before the request line (RFC 9112 §2.2 leniency, deliberately refused)",
    wire: "\r\nGET /x HTTP/1.1\r\nHost: h.test\r\n\r\n",
    pattern: /malformed request line/,
  },
];

describe("strictness: every ambiguous message is refused, never guessed (19 cases)", () => {
  it.each(CORPUS)("rejects $name", async ({ wire, pattern, maxHeaderBytes }) => {
    await expect(parse(wire, maxHeaderBytes)).rejects.toThrow(pattern);
  });

  // I2: every refusal from decodeRequest/decodeResponse — including a bare LF
  // (a ByteStreamError from the underlying ByteReader, not an HttpParseError
  // by construction) — must reach the caller as HttpParseError. Otherwise
  // `catch (e) { if (e instanceof HttpParseError) ... }`, the obvious way to
  // consume this codec's documented error contract, crashes on exactly the
  // kind of malformed input it exists to catch.
  it.each(CORPUS)("rejects $name with HttpParseError specifically", async ({
    wire,
    maxHeaderBytes,
  }) => {
    await expect(parse(wire, maxHeaderBytes)).rejects.toThrow(HttpParseError);
  });
});
