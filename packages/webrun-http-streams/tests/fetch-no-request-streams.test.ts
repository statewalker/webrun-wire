import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodec } from "../src/codec-default.js";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";
import { httpServe } from "../src/http-data.js";
import { NoStreamsRequest, withoutRequestStreams } from "./support/no-streams-request.js";

/**
 * Request-streams regression test (Task 21): Firefox 146 implements neither
 * half of request body streams —
 * `Object.getOwnPropertyDescriptor(Request.prototype, "body")` is `null`, and
 * a `ReadableStream` handed to the constructor is stringified rather than
 * consumed. Outbound, that sent every non-GET from a Firefox page bodyless,
 * and a JSON endpoint answered 500 `Unexpected end of JSON input`. Inbound —
 * the silent half — the handler read the literal text `[object ReadableStream]`
 * and answered 200 with corrupt data.
 *
 * Rather than require a browser, these tests install a `Request` that behaves
 * as Firefox's does and run the real code under Node. That absent accessor is
 * exactly the capability `fetch.ts` feature-detects, so the branches taken here
 * are the branches Firefox takes.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A `Duplex` that records the raw request bytes and replies with a canned
 * HTTP/1.1 200. Nothing on this side constructs a `Request`, so an outbound
 * assertion is about the wire alone.
 */
function capturingDuplex(): { call: Duplex; wire: () => string } {
  let text = "";
  const call: Duplex = async function* (input) {
    for await (const chunk of input) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    yield encoder.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  };
  return { call, wire: () => text };
}

/**
 * Drive a server `Duplex` with a hand-rolled request and return its response
 * body as text. Bypasses `fetchOverDuplex` so the inbound tests exercise the
 * server side alone, whatever the client-side `Request` happens to support.
 */
async function callServer(
  call: Duplex,
  method: string,
  body?: AsyncIterable<Uint8Array>,
): Promise<string> {
  const request = defaultCodec.encodeRequest(
    { url: "http://peer/echo", method, headers: [] },
    body,
  );
  const decoded = await defaultCodec.decodeResponse(call(request), { method });
  const parts: string[] = [];
  for await (const chunk of decoded.body) parts.push(decoder.decode(chunk, { stream: true }));
  parts.push(decoder.decode());
  return parts.join("");
}

describe("fetch.ts on a runtime without request streams (the Firefox shape)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("the stand-in reproduces Firefox: no `body` accessor, and a stream is stringified", async () => {
    expect(Object.getOwnPropertyDescriptor(NoStreamsRequest.prototype, "body")).toBeUndefined();
    expect("body" in new NoStreamsRequest("http://x/")).toBe(false);
    // Native `Request` has it — this is the difference being detected.
    expect(Object.getOwnPropertyDescriptor(Request.prototype, "body")).not.toBeUndefined();

    restore = withoutRequestStreams();
    const request = new Request("http://x/", {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    } as RequestInit);
    // This is what `serveFetchOverDuplex` used to hand every handler.
    await expect(request.text()).resolves.toBe("[object ReadableStream]");
  });

  describe("outbound — fetchOverDuplex", () => {
    it("buffers and sends the body when `request.body` is unavailable", async () => {
      restore = withoutRequestStreams();
      const { call, wire } = capturingDuplex();

      const request = new Request("http://peer/echo", {
        method: "POST",
        body: JSON.stringify({ hello: "firefox" }),
        headers: { "content-type": "application/json" },
      });
      const response = await fetchOverDuplex(call, request);

      expect(await response.text()).toBe("ok");
      // Pre-fix the request went out bodyless and a JSON endpoint answered
      // 500 `Unexpected end of JSON input`.
      expect(wire()).toContain('{"hello":"firefox"}');
    });

    it("frames no body at all for a zero-length one", async () => {
      restore = withoutRequestStreams();
      const { call, wire } = capturingDuplex();

      await fetchOverDuplex(call, new Request("http://peer/echo", { method: "POST", body: "" }));

      // The documented divergence: buffering cannot tell an empty body from an
      // absent one, so unlike Chromium — which streams a non-null empty body
      // and frames a chunked envelope for it — nothing is framed here. Both
      // decode to zero bytes at the far end.
      expect(wire()).not.toContain("Transfer-Encoding");
      expect(wire().endsWith("\r\n\r\n")).toBe(true);
    });

    it("still streams chunk by chunk when `request.body` exists", async () => {
      // No stand-in installed: Node has request streams, so this is the
      // untouched path Chromium takes. Two chunks in, two chunks out.
      const chunks: string[] = [];
      const call = httpServe(async (env, body) => {
        for await (const chunk of body) chunks.push(decoder.decode(chunk));
        expect(env.method).toBe("POST");
        return {
          envelope: { status: 200, statusText: "OK", headers: [] },
          body: [encoder.encode("ok")],
        };
      });

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first-"));
          controller.enqueue(encoder.encode("second"));
          controller.close();
        },
      });
      const request = new Request("http://peer/echo", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit);
      const response = await fetchOverDuplex(call, request);

      expect(await response.text()).toBe("ok");
      expect(chunks.join("")).toBe("first-second");
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("inbound — serveFetchOverDuplex", () => {
    it("hands the handler the real bytes, not a stringified stream", async () => {
      restore = withoutRequestStreams();
      let seen: unknown;
      const call = serveFetchOverDuplex(async (request) => {
        seen = await request.json();
        return new Response("ok");
      });

      const body = (async function* () {
        yield encoder.encode('{"hello":');
        yield encoder.encode('"firefox"}');
      })();

      expect(await callServer(call, "POST", body)).toBe("ok");
      // Pre-fix `seen` was the text `[object ReadableStream]` — the silent
      // failure: a 200 carrying corrupt data, or a JSON parse error blamed on
      // the caller.
      expect(seen).toEqual({ hello: "firefox" });
    });

    it("passes an empty body through rather than dropping it", async () => {
      restore = withoutRequestStreams();
      let seen: string | undefined;
      const call = serveFetchOverDuplex(async (request) => {
        seen = await request.text();
        return new Response("ok");
      });

      expect(await callServer(call, "POST")).toBe("ok");
      expect(seen).toBe("");
    });

    it("leaves GET alone — no body is constructed", async () => {
      restore = withoutRequestStreams();
      let method: string | undefined;
      const call = serveFetchOverDuplex(async (request) => {
        method = request.method;
        return new Response("ok");
      });

      expect(await callServer(call, "GET")).toBe("ok");
      expect(method).toBe("GET");
    });

    it("still streams the request body into the handler when the runtime supports it", async () => {
      // Again with no stand-in: the handler must see a live `request.body`,
      // not a buffered one.
      const chunks: string[] = [];
      const call = serveFetchOverDuplex(async (request) => {
        expect(request.body).not.toBeNull();
        const reader = (request.body as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) chunks.push(decoder.decode(value));
        }
        return new Response("ok");
      });

      const body = (async function* () {
        yield encoder.encode("first-");
        yield encoder.encode("second");
      })();

      expect(await callServer(call, "POST", body)).toBe("ok");
      expect(chunks.join("")).toBe("first-second");
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});
