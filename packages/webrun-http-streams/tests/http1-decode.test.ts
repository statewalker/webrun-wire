import { describe, expect, it } from "vitest";
import { decodeRequest, decodeResponse } from "../src/http1/decode.js";
import type { ResolvedHttpCodecOptions } from "../src/http1/encode.js";
import { HttpParseError } from "../src/http1/errors.js";

const OPTS: ResolvedHttpCodecOptions = {
  scheme: "http",
  host: "fallback.test",
  maxHeaderBytes: 65536,
};
const HTTPS: ResolvedHttpCodecOptions = { ...OPTS, scheme: "https" };
const enc = (s: string) => new TextEncoder().encode(s);

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("decodeRequest", () => {
  it("rebuilds an absolute url from the target, Host and configured scheme", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET /api?a=1&b=two&empty= HTTP/1.1\r\nHost: example.test\r\n\r\n")],
      OPTS,
    );
    expect(envelope.url).toBe("http://example.test/api?a=1&b=two&empty=");
    expect(envelope.method).toBe("GET");
  });

  it("uses the configured scheme, which is not on the wire", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET /x HTTP/1.1\r\nHost: example.test\r\n\r\n")],
      HTTPS,
    );
    expect(envelope.url).toBe("https://example.test/x");
  });

  it("surfaces every header verbatim, framing headers included", async () => {
    const { envelope } = await decodeRequest(
      [enc("POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Length: 2\r\nX-Case: Kept\r\n\r\nhi")],
      OPTS,
    );
    expect(envelope.headers).toEqual([
      ["Host", "h.test"],
      ["Content-Length", "2"],
      ["X-Case", "Kept"],
    ]);
  });

  it("reads a Content-Length body", async () => {
    const { body } = await decodeRequest(
      [enc("POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Length: 5\r\n\r\nhello")],
      OPTS,
    );
    expect(await text(body)).toBe("hello");
  });

  it("reads a chunked body split across transport chunks", async () => {
    const { body } = await decodeRequest(
      [
        enc("POST /x HTTP/1.1\r\nHost: h.test\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel"),
        enc("lo\r\n2\r\n, \r\n"),
        enc("6\r\nworld!\r\n0\r\n\r\n"),
      ],
      OPTS,
    );
    expect(await text(body)).toBe("hello, world!");
  });

  it("treats a request with no framing as having an empty body", async () => {
    const { body } = await decodeRequest([enc("GET /x HTTP/1.1\r\nHost: h.test\r\n\r\n")], OPTS);
    expect(await text(body)).toBe("");
  });

  it("accepts absolute-form, which RFC 9112 says a server must accept", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET https://origin.test/p?q=1 HTTP/1.1\r\nHost: origin.test\r\n\r\n")],
      OPTS,
    );
    expect(envelope.url).toBe("https://origin.test/p?q=1");
  });

  it("rejects an HTTP/1.1 request with no Host", async () => {
    await expect(decodeRequest([enc("GET /x HTTP/1.1\r\n\r\n")], OPTS)).rejects.toThrow(/no Host/);
  });

  it("rejects asterisk-form", async () => {
    await expect(
      decodeRequest([enc("OPTIONS * HTTP/1.1\r\nHost: h.test\r\n\r\n")], OPTS),
    ).rejects.toThrow(/asterisk-form/);
  });

  it("rejects a control character embedded in the request target", async () => {
    await expect(
      decodeRequest([enc("GET /a\x00b\rc HTTP/1.1\r\nHost: h.test\r\n\r\n")], OPTS),
    ).rejects.toThrow(/invalid request-target/);
  });

  it("rejects an unsupported version", async () => {
    await expect(
      decodeRequest([enc("GET /x HTTP/2.0\r\nHost: h.test\r\n\r\n")], OPTS),
    ).rejects.toThrow(/unsupported HTTP version/);
  });

  it("converts a ByteStreamError raised while draining the body into HttpParseError", async () => {
    // The chunk-size line's CRLF never arrives — a ByteStreamError from the
    // ByteReader, raised well after decodeRequest itself already resolved.
    // I2: it must still reach the caller as HttpParseError, not leak the
    // internal, unexported ByteStreamError class.
    const { body } = await decodeRequest(
      [enc("POST /x HTTP/1.1\r\nHost: h.test\r\nTransfer-Encoding: chunked\r\n\r\n5")],
      OPTS,
    );
    await expect(text(body)).rejects.toThrow(HttpParseError);
  });

  it("propagates a genuine transport error unchanged, not wrapped as HttpParseError", async () => {
    // I2 is explicit that only ByteStreamError is converted; a real failure
    // from the underlying source (a dropped socket, say) must reach the
    // caller as itself.
    const boom = new Error("socket reset");
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(boom) };
      },
    };
    await expect(decodeRequest(source, OPTS)).rejects.toBe(boom);
  });

  it("rejects a truncated Content-Length body", async () => {
    const { body } = await decodeRequest(
      [enc("POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Length: 10\r\n\r\nshort")],
      OPTS,
    );
    await expect(text(body)).rejects.toThrow(/body truncated/);
  });

  it("rejects a present-but-empty Host header", async () => {
    await expect(decodeRequest([enc("GET /x HTTP/1.1\r\nHost: \r\n\r\n")], OPTS)).rejects.toThrow(
      /invalid Host header/,
    );
  });

  it("rejects a Host header carrying userinfo", async () => {
    await expect(
      decodeRequest([enc("GET /x HTTP/1.1\r\nHost: evil.com@good.com\r\n\r\n")], OPTS),
    ).rejects.toThrow(/invalid Host header/);
  });

  it("rejects a Host header containing whitespace", async () => {
    await expect(
      decodeRequest([enc("GET /x HTTP/1.1\r\nHost: exa mple.test\r\n\r\n")], OPTS),
    ).rejects.toThrow(/invalid Host header/);
  });

  it("accepts an IP-literal Host with a port", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET /x HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n")],
      OPTS,
    );
    expect(envelope.url).toBe("http://[::1]:8080/x");
  });

  it("accepts a reg-name Host with a port", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET /x HTTP/1.1\r\nHost: example.test:8080\r\n\r\n")],
      OPTS,
    );
    expect(envelope.url).toBe("http://example.test:8080/x");
  });

  it("accepts a punycode Host with underscores and a trailing dot", async () => {
    const { envelope } = await decodeRequest(
      [enc("GET /x HTTP/1.1\r\nHost: xn--fsq.my_host.test.\r\n\r\n")],
      OPTS,
    );
    expect(envelope.url).toBe("http://xn--fsq.my_host.test./x");
  });

  it("rejects a Host smuggling a second authority via a sub-delim (Host grammar tightening)", async () => {
    // HOST_REG_NAME used to admit sub-delims, so "a.test,b.test" passed
    // grammar validation *and* survived `new URL()` intact — the fail-safe
    // argument for keeping sub-delims was narrower than believed.
    await expect(
      decodeRequest([enc("GET /x HTTP/1.1\r\nHost: a.test,b.test\r\n\r\n")], OPTS),
    ).rejects.toThrow(/invalid Host header/);
  });

  it("rejects an assembled url that new URL() itself refuses, even though Host grammar passed", async () => {
    // Belt-and-braces: "999.999.999.999" is legal under the tightened
    // HOST_REG_NAME grammar (digits and dots), but is not a value `new URL()`
    // accepts as a host.
    await expect(
      decodeRequest([enc("GET /x HTTP/1.1\r\nHost: 999.999.999.999\r\n\r\n")], OPTS),
    ).rejects.toThrow(/decoded url is not a valid URL/);
  });
});

describe("decodeResponse", () => {
  it("reads status, reason phrase and body", async () => {
    const { envelope, body } = await decodeResponse(
      [enc("HTTP/1.1 201 Created\r\nContent-Length: 4\r\n\r\npong")],
      OPTS,
      "POST",
    );
    expect(envelope.status).toBe(201);
    expect(envelope.statusText).toBe("Created");
    expect(await text(body)).toBe("pong");
  });

  it("accepts an empty reason phrase", async () => {
    const { envelope } = await decodeResponse([enc("HTTP/1.1 200 \r\n\r\n")], OPTS, "GET");
    expect(envelope.status).toBe(200);
    expect(envelope.statusText).toBe("");
  });

  it("reads an EOF-delimited body when no framing is declared", async () => {
    const { body } = await decodeResponse(
      [enc("HTTP/1.1 200 OK\r\n\r\nstreamed "), enc("to the end")],
      OPTS,
      "GET",
    );
    expect(await text(body)).toBe("streamed to the end");
  });

  it("reads no body for 204 even with a Content-Length present", async () => {
    const { body } = await decodeResponse(
      [enc("HTTP/1.1 204 No Content\r\nContent-Length: 5\r\n\r\n")],
      OPTS,
      "GET",
    );
    expect(await text(body)).toBe("");
  });

  it("reads no body for a response to HEAD", async () => {
    const { envelope, body } = await decodeResponse(
      [enc("HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n")],
      OPTS,
      "HEAD",
    );
    expect(envelope.status).toBe(200);
    expect(await text(body)).toBe("");
  });

  it("rejects an invalid status code", async () => {
    await expect(decodeResponse([enc("HTTP/1.1 2xx OK\r\n\r\n")], OPTS, "GET")).rejects.toThrow(
      /invalid status code/,
    );
  });
});
