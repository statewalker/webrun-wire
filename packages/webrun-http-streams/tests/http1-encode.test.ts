import { describe, expect, it } from "vitest";
import type { ResolvedHttpCodecOptions } from "../src/http1/encode.js";
import { encodeRequest, encodeResponse, splitTarget } from "../src/http1/encode.js";

const OPTS: ResolvedHttpCodecOptions = {
  scheme: "http",
  host: "fallback.test",
  maxHeaderBytes: 65536,
};
const enc = (s: string) => new TextEncoder().encode(s);

/** A body whose `finally` marks itself released — proves `drain()` actually ran it. */
async function* bodyWithFinally(flag: { released: boolean }): AsyncGenerator<Uint8Array> {
  try {
    yield enc("x");
  } finally {
    flag.released = true;
  }
}

async function wire(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of gen) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("splitTarget", () => {
  it("preserves the query string verbatim", () => {
    expect(splitTarget("https://example.test/a/b?x=1&y=two&empty=", OPTS)).toEqual({
      target: "/a/b?x=1&y=two&empty=",
      authority: "example.test",
    });
  });

  it("does not normalise percent-encoding", () => {
    expect(splitTarget("http://h.test/a%2Fb%20c?q=%7B%7D", OPTS).target).toBe(
      "/a%2Fb%20c?q=%7B%7D",
    );
  });

  it("keeps the port in the authority", () => {
    expect(splitTarget("http://127.0.0.1:8080/x", OPTS).authority).toBe("127.0.0.1:8080");
  });

  it("uses the configured host for a bare path", () => {
    expect(splitTarget("/x?y=1", OPTS)).toEqual({ target: "/x?y=1", authority: "fallback.test" });
  });

  it("substitutes / for an empty path", () => {
    expect(splitTarget("https://example.test", OPTS).target).toBe("/");
  });

  it("drops the fragment, which is never sent", () => {
    expect(splitTarget("http://h.test/x?a=1#frag", OPTS).target).toBe("/x?a=1");
  });

  it("prefixes a leading slash when the path is empty but a query is present", () => {
    expect(splitTarget("https://example.test?a=1", OPTS).target).toBe("/?a=1");
  });

  it("strips userinfo from the authority before it reaches Host", () => {
    expect(splitTarget("http://user:pass@host/x", OPTS).authority).toBe("host");
  });

  it("rejects a bare-path target smuggling a second request line via CRLF", () => {
    expect(() =>
      splitTarget(
        "/search?q=a\r\nX-Injected: yes\r\nGET /admin HTTP/1.1\r\nHost: h.test\r\n\r\n",
        OPTS,
      ),
    ).toThrow(/invalid request-target/);
  });

  it("rejects an authority smuggling a header via CRLF", () => {
    expect(() => splitTarget("http://ho\r\nX-Inj: 1\r\nst.test/x", OPTS)).toThrow(
      /invalid Host header/,
    );
  });
});

describe("encodeRequest", () => {
  it("writes an origin-form request line, Host, and Connection: close", async () => {
    const out = await wire(
      encodeRequest(
        { url: "https://example.test/api?a=1", method: "GET", headers: [] },
        undefined,
        OPTS,
      ),
    );
    expect(out).toBe("GET /api?a=1 HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n");
  });

  it("emits no framing headers when there is no body", async () => {
    const out = await wire(
      encodeRequest({ url: "/x", method: "GET", headers: [] }, undefined, OPTS),
    );
    expect(out).not.toMatch(/content-length/i);
    expect(out).not.toMatch(/transfer-encoding/i);
  });

  it("chunks a body of unknown length", async () => {
    const out = await wire(
      encodeRequest({ url: "/x", method: "POST", headers: [] }, [enc("ab"), enc("cd")], OPTS),
    );
    expect(out).toBe(
      "POST /x HTTP/1.1\r\nHost: fallback.test\r\nConnection: close\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n",
    );
  });

  it("honours a caller-supplied Content-Length instead of chunking", async () => {
    const out = await wire(
      encodeRequest(
        { url: "/x", method: "POST", headers: [["Content-Length", "4"]] },
        [enc("abcd")],
        OPTS,
      ),
    );
    expect(out).toContain("Content-Length: 4\r\n");
    expect(out).not.toContain("Transfer-Encoding");
    expect(out.endsWith("\r\n\r\nabcd")).toBe(true);
  });

  it("throws when the body is shorter than the declared Content-Length", async () => {
    await expect(
      wire(
        encodeRequest(
          { url: "/x", method: "POST", headers: [["Content-Length", "9"]] },
          [enc("abcd")],
          OPTS,
        ),
      ),
    ).rejects.toThrow(/body is 4 bytes but Content-Length declares 9/);
  });

  it("throws when the body is longer than the declared Content-Length", async () => {
    await expect(
      wire(
        encodeRequest(
          { url: "/x", method: "POST", headers: [["Content-Length", "2"]] },
          [enc("abcd")],
          OPTS,
        ),
      ),
    ).rejects.toThrow(/exceeds declared Content-Length/);
  });

  it("drops and re-derives caller-supplied Host, Connection and Transfer-Encoding", async () => {
    const out = await wire(
      encodeRequest(
        {
          url: "https://real.test/x",
          method: "GET",
          headers: [
            ["Host", "spoofed.test"],
            ["Connection", "keep-alive"],
            ["Transfer-Encoding", "chunked"],
            ["X-Keep", "kept"],
          ],
        },
        undefined,
        OPTS,
      ),
    );
    expect(out).toContain("Host: real.test\r\n");
    expect(out).not.toContain("spoofed.test");
    expect(out).not.toContain("keep-alive");
    expect(out).toContain("X-Keep: kept\r\n");
    expect(out.match(/Transfer-Encoding/g)).toBeNull();
  });

  it("throws rather than emit a declared Content-Length with no body at all", async () => {
    await expect(
      wire(
        encodeRequest(
          { url: "/x", method: "POST", headers: [["Content-Length", "5"]] },
          undefined,
          OPTS,
        ),
      ),
    ).rejects.toThrow(/body is 0 bytes but Content-Length declares 5/);
  });

  it("allows a declared Content-Length of 0 with no body", async () => {
    const out = await wire(
      encodeRequest(
        { url: "/x", method: "POST", headers: [["Content-Length", "0"]] },
        undefined,
        OPTS,
      ),
    );
    expect(out).toContain("Content-Length: 0\r\n");
  });

  it("rejects an invalid method", async () => {
    await expect(
      wire(encodeRequest({ url: "/x", method: "BAD METHOD", headers: [] }, undefined, OPTS)),
    ).rejects.toThrow(/invalid method/);
  });
});

describe("encodeResponse", () => {
  it("writes a status line with the reason phrase", async () => {
    const out = await wire(
      encodeResponse({ status: 201, statusText: "Created", headers: [] }, undefined, OPTS),
    );
    expect(out).toBe("HTTP/1.1 201 Created\r\nConnection: close\r\n\r\n");
  });

  it("emits no body or framing for 204", async () => {
    const out = await wire(
      encodeResponse({ status: 204, statusText: "No Content", headers: [] }, [enc("x")], OPTS),
    );
    expect(out).toBe("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
  });

  it("drops a caller-supplied Content-Length on a 204 (RFC 9110 §8.6)", async () => {
    const out = await wire(
      encodeResponse(
        { status: 204, statusText: "No Content", headers: [["Content-Length", "5"]] },
        undefined,
        OPTS,
      ),
    );
    expect(out).not.toMatch(/content-length/i);
  });

  it("keeps a caller-supplied Content-Length on a response to HEAD", async () => {
    const out = await wire(
      encodeResponse(
        { status: 200, statusText: "OK", headers: [["Content-Length", "12"]] },
        undefined,
        OPTS,
        "HEAD",
      ),
    );
    expect(out).toContain("Content-Length: 12\r\n");
  });

  it("rejects a control character in statusText", async () => {
    await expect(
      wire(encodeResponse({ status: 200, statusText: "OK\x01here", headers: [] }, undefined, OPTS)),
    ).rejects.toThrow(/control character/);
  });

  it("emits no body for a response to HEAD", async () => {
    const out = await wire(
      encodeResponse(
        { status: 200, statusText: "OK", headers: [["Content-Type", "text/plain"]] },
        [enc("hello")],
        OPTS,
        "HEAD",
      ),
    );
    expect(out).toBe("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n");
  });

  it("throws rather than emit a declared Content-Length with no body at all", async () => {
    await expect(
      wire(
        encodeResponse(
          { status: 200, statusText: "OK", headers: [["Content-Length", "5"]] },
          undefined,
          OPTS,
        ),
      ),
    ).rejects.toThrow(/body is 0 bytes but Content-Length declares 5/);
  });

  it("allows a declared Content-Length of 0 with no body", async () => {
    const out = await wire(
      encodeResponse(
        { status: 200, statusText: "OK", headers: [["Content-Length", "0"]] },
        undefined,
        OPTS,
      ),
    );
    expect(out).toContain("Content-Length: 0\r\n");
  });

  it("rejects a status outside 100..599", async () => {
    await expect(
      wire(encodeResponse({ status: 99, statusText: "", headers: [] }, undefined, OPTS)),
    ).rejects.toThrow(/invalid status/);
  });

  it("releases the discarded body's underlying resource for a 204 response", async () => {
    const flag = { released: false };
    await wire(
      encodeResponse(
        { status: 204, statusText: "No Content", headers: [] },
        bodyWithFinally(flag),
        OPTS,
      ),
    );
    expect(flag.released).toBe(true);
  });

  it("releases the discarded body's underlying resource for a response to HEAD", async () => {
    const flag = { released: false };
    await wire(
      encodeResponse(
        { status: 200, statusText: "OK", headers: [] },
        bodyWithFinally(flag),
        OPTS,
        "HEAD",
      ),
    );
    expect(flag.released).toBe(true);
  });
});
