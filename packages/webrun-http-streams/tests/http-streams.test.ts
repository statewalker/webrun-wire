import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import {
  fetchOverDuplex,
  httpFetch,
  httpServe,
  type RequestEnvelope,
  serveFetchOverDuplex,
} from "../src/index.js";

/**
 * Loopback caller: a `Duplex` that invokes the given handler directly. Used
 * for unit tests — no transport, no mux.
 */
function loopback(handler: Duplex): Duplex {
  return (input) => handler(input);
}

describe("httpFetch / httpServe (data layer)", () => {
  it("GET round-trips an envelope and body", async () => {
    const handler: Duplex = httpServe(async (env) => {
      return {
        envelope: {
          status: 200,
          statusText: "OK",
          headers: [["content-type", "text/plain"]],
        },
        body: (async function* () {
          yield new TextEncoder().encode(`hello ${env.method} ${env.url}`);
        })(),
      };
    });
    const call = loopback(handler);
    const env: RequestEnvelope = {
      url: "/x",
      method: "GET",
      headers: [],
    };
    const { envelope, body } = await httpFetch(call, env);
    expect(envelope.status).toBe(200);
    const bytes: Uint8Array[] = [];
    for await (const chunk of body) bytes.push(chunk);
    const total = bytes.reduce((a, b) => a + b.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of bytes) {
      out.set(b, off);
      off += b.byteLength;
    }
    expect(new TextDecoder().decode(out)).toBe("hello GET http://localhost/x");
  });

  it("POST round-trips a streaming body", async () => {
    const handler: Duplex = httpServe(async (_env, body) => {
      const chunks: Uint8Array[] = [];
      for await (const c of body) chunks.push(c);
      const total = chunks.reduce((a, b) => a + b.byteLength, 0);
      const echo = new Uint8Array(total);
      let off = 0;
      for (const b of chunks) {
        echo.set(b, off);
        off += b.byteLength;
      }
      return {
        envelope: { status: 200, statusText: "OK", headers: [] },
        body: (async function* () {
          yield echo;
        })(),
      };
    });
    const call = loopback(handler);
    const env: RequestEnvelope = {
      url: "/echo",
      method: "POST",
      headers: [],
    };
    async function* body() {
      yield new TextEncoder().encode("ab");
      yield new TextEncoder().encode("cd");
    }
    const result = await httpFetch(call, env, body());
    const all: Uint8Array[] = [];
    for await (const c of result.body) all.push(c);
    expect(new TextDecoder().decode(all[0])).toBe("abcd");
  });

  it("handler error surfaces on the caller", async () => {
    const handler: Duplex = httpServe(async () => {
      throw new Error("boom");
    });
    const call = loopback(handler);
    await expect(httpFetch(call, { url: "/x", method: "GET", headers: [] })).rejects.toThrow(
      /boom/,
    );
  });

  // I3: the HEAD plumbing is composed across two seams — httpServe must tell
  // the codec which request method it is answering (src/http1/index.ts:33),
  // and httpFetch must tell the codec which method it sent (index.ts:34).
  // Neither seam is exercised by the http1/decode.ts and http1/encode.ts unit
  // tests, which pass a literal "HEAD" directly; only a full round trip
  // through httpFetch/httpServe proves the wiring itself is correct.
  describe("HEAD plumbing (I3)", () => {
    it("never puts Transfer-Encoding on the wire for a HEAD response, even though the handler returns a body", async () => {
      // Catches the server-side mutation: if httpServe forgot to tell the
      // codec the request was HEAD, encodeResponse would treat this as an
      // ordinary response and chunk the handler's body onto the wire.
      const handler: Duplex = httpServe(async () => ({
        envelope: { status: 200, statusText: "OK", headers: [["Content-Type", "text/plain"]] },
        body: (async function* () {
          yield new TextEncoder().encode("must never reach the wire for HEAD");
        })(),
      }));
      const call = loopback(handler);
      const { envelope, body } = await httpFetch(call, { url: "/x", method: "HEAD", headers: [] });
      expect(envelope.status).toBe(200);
      expect(envelope.headers.some(([k]) => k.toLowerCase() === "transfer-encoding")).toBe(false);
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of body) out += dec.decode(chunk, { stream: true });
      expect(out).toBe("");
    });

    it("a client that trusts its own request method reads no body despite a declared Content-Length", async () => {
      // Catches the client-side mutation: if httpFetch's decode call forgot
      // which method it actually sent, it would try to read a body governed
      // by the Content-Length the handler legitimately kept for HEAD (M4) —
      // a body that a correct server never sends and that will never arrive.
      const handler: Duplex = httpServe(async () => ({
        envelope: { status: 200, statusText: "OK", headers: [["Content-Length", "5"]] },
        body: (async function* () {
          yield new TextEncoder().encode("hello");
        })(),
      }));
      const call = loopback(handler);
      const { envelope, body } = await httpFetch(call, { url: "/x", method: "HEAD", headers: [] });
      expect(envelope.status).toBe(200);
      let out = "";
      const dec = new TextDecoder();
      for await (const chunk of body) out += dec.decode(chunk, { stream: true });
      expect(out).toBe("");
    });
  });
});

describe("fetchOverDuplex / serveFetchOverDuplex (Request/Response layer)", () => {
  it("round-trips Request → Response", async () => {
    const handler: Duplex = serveFetchOverDuplex(async (request) => {
      const body = await request.text();
      return new Response(`got: ${body}`, {
        status: 201,
        headers: { "content-type": "text/plain" },
      });
    });
    const call = loopback(handler);
    const req = new Request("https://example.test/x", {
      method: "POST",
      body: "hello",
    });
    const resp = await fetchOverDuplex(call, req);
    expect(resp.status).toBe(201);
    expect(await resp.text()).toBe("got: hello");
  });

  it("GET with no body works", async () => {
    const handler: Duplex = serveFetchOverDuplex(async (request) => {
      return new Response(`url=${new URL(request.url).pathname}`, { status: 200 });
    });
    const call = loopback(handler);
    const resp = await fetchOverDuplex(call, new Request("https://example.test/api/time"));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("url=/api/time");
  });

  it("streaming response body arrives in order", async () => {
    const handler: Duplex = serveFetchOverDuplex(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode("a"));
          controller.enqueue(enc.encode("b"));
          controller.enqueue(enc.encode("c"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const call = loopback(handler);
    const resp = await fetchOverDuplex(call, new Request("https://example.test/"));
    expect(await resp.text()).toBe("abc");
  });
});
