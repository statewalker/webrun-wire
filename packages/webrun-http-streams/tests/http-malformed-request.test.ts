import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { httpCodec } from "../src/http1/index.js";
import { httpServe } from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("malformed request", () => {
  it("gets a conforming 400 rather than silence", async () => {
    const serve: Duplex = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [enc("never reached")],
    }));
    // Two Host headers: a refusal the decoder raises before any handler runs.
    const bad = "GET /x HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n";
    const decoded = await httpCodec.decodeResponse(serve([enc(bad)]), { method: "GET" });
    expect(decoded.envelope.status).toBe(400);
    let body = "";
    for await (const c of decoded.body) body += new TextDecoder().decode(c);
    expect(body).toMatch(/multiple Host headers/);
  });

  it("a genuine transport error still propagates, not turned into a 400", async () => {
    const boom = new Error("transport exploded");
    const serve: Duplex = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [],
    }));
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield enc("GET /x HTTP/1.1\r\n");
      throw boom;
    }
    await expect(async () => {
      for await (const _c of serve(failing())) {
        /* drain */
      }
    }).rejects.toThrow(/transport exploded/);
  });

  it("a real peer can read the 400 as conforming HTTP", async () => {
    const serve: Duplex = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [],
    }));
    let wire = "";
    const dec = new TextDecoder();
    for await (const c of serve([enc("GET /x HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n")])) {
      wire += dec.decode(c, { stream: true });
    }
    wire += dec.decode();
    expect(wire.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
    expect(wire).toContain("Connection: close\r\n");
  });

  // Every refusal route must reach the 400, not just the ones raised directly
  // by decode.ts. A bare LF originates as a ByteStreamError inside ByteReader
  // and is converted at the http1/ boundary; an unrecognised first byte is the
  // sniffing codec's own refusal. If either escaped as something other than an
  // HttpParseError the peer would get silence again.
  it.each([
    ["bare LF line terminator", "GET /x HTTP/1.1\nHost: h.test\r\n\r\n"],
    ["first byte no codec claims", "\x00\x01garbage"],
    [
      "head over maxHeaderBytes",
      `GET /x HTTP/1.1\r\nHost: h.test\r\nX: ${"a".repeat(70000)}\r\n\r\n`,
    ],
    ["malformed request line", "NOT-A-REQUEST\r\n\r\n"],
    [
      "Content-Length with Transfer-Encoding",
      "POST /x HTTP/1.1\r\nHost: h.test\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    ],
  ])("answers 400 for %s", async (_name, input) => {
    const serve: Duplex = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [],
    }));
    let out = "";
    const d = new TextDecoder();
    for await (const c of serve([enc(input)])) out += d.decode(c, { stream: true });
    out += d.decode();
    expect(out).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(out).toContain("Connection: close\r\n");
  });
});
