import { afterEach, describe, expect, it } from "vitest";
import {
  newHttpClientStub,
  newHttpServerStub,
  type SerializedHttpEnvelope,
  type SerializedHttpRequest,
} from "../src/http-stubs.js";
import { type NoStreamsRequest, withoutRequestStreams } from "./support/no-streams-request.js";

/**
 * The same platform gap as `fetch-no-request-streams.test.ts`, in the other
 * pair of directions. `newHttpClientStub` and `newHttpServerStub` carried the
 * identical two bugs — a bodyless envelope out, and a stringified stream in —
 * and they are not dead code: `webrun-http-browser` builds its send/receive
 * bridge on both, so this is a browser-targeted path.
 *
 * `apps/httpeers-stack` does not route through these stubs (it uses
 * `serveFetchOverDuplex`), so nothing in that stack ever surfaced the defect.
 * That is exactly why it needs a test of its own.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of source) parts.push(decoder.decode(chunk, { stream: true }));
  parts.push(decoder.decode());
  return parts.join("");
}

/** Envelope carrying a body split across two chunks, to catch a lost boundary. */
function requestEnvelope(
  method: string,
  chunks: string[] = [],
): SerializedHttpEnvelope<SerializedHttpRequest> {
  return {
    options: { url: "http://peer/echo", method, headers: [] },
    content: (async function* () {
      for (const chunk of chunks) yield encoder.encode(chunk);
    })(),
  };
}

describe("http-stubs on a runtime without request streams (the Firefox shape)", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  describe("outbound — newHttpClientStub", () => {
    it("buffers and sends the body when `request.body` is unavailable", async () => {
      restore = withoutRequestStreams();
      let sent: string | undefined;
      const stub = newHttpClientStub(async (envelope) => {
        sent = await collect(envelope.content);
        return {
          options: { status: 200, statusText: "OK", headers: {} },
          content: (async function* () {
            yield encoder.encode("ok");
          })(),
        };
      });

      const request = new Request("http://peer/echo", {
        method: "POST",
        body: JSON.stringify({ hello: "firefox" }),
      });
      const response = await stub(request as unknown as Request);

      expect(await response.text()).toBe("ok");
      // Pre-fix this was "", so a JSON endpoint answered
      // 500 `Unexpected end of JSON input`.
      expect(sent).toBe('{"hello":"firefox"}');
    });

    it("sends nothing for a zero-length body", async () => {
      restore = withoutRequestStreams();
      let sent: string | undefined;
      const stub = newHttpClientStub(async (envelope) => {
        sent = await collect(envelope.content);
        return {
          options: { status: 200, statusText: "OK", headers: {} },
          content: (async function* () {})(),
        };
      });

      await stub(new Request("http://peer/echo", { method: "POST", body: "" }));

      // Unlike `fetch.ts`, no divergence arises here: this envelope always
      // carries a `content` iterable, so an empty body and an absent one are
      // already the same thing on this transport.
      expect(sent).toBe("");
    });

    it("still streams, chunk by chunk, when `request.body` exists", async () => {
      // No stand-in installed: Node has request streams, so this is the
      // untouched path Chromium takes.
      const chunks: string[] = [];
      const stub = newHttpClientStub(async (envelope) => {
        for await (const chunk of envelope.content) chunks.push(decoder.decode(chunk));
        return {
          options: { status: 200, statusText: "OK", headers: {} },
          content: (async function* () {
            yield encoder.encode("ok");
          })(),
        };
      });

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("first-"));
          controller.enqueue(encoder.encode("second"));
          controller.close();
        },
      });
      const response = await stub(
        new Request("http://peer/echo", { method: "POST", body, duplex: "half" } as RequestInit),
      );

      expect(await response.text()).toBe("ok");
      expect(chunks.join("")).toBe("first-second");
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("inbound — newHttpServerStub", () => {
    it("hands the handler the real bytes, not a stringified stream", async () => {
      restore = withoutRequestStreams();
      let seen: unknown;
      const stub = newHttpServerStub(async (request) => {
        seen = await (request as unknown as NoStreamsRequest).json();
        return new Response("ok");
      });

      const result = await stub(requestEnvelope("POST", ['{"hello":', '"firefox"}']));

      expect(result.options.status).toBe(200);
      expect(await collect(result.content)).toBe("ok");
      // Pre-fix `seen` was the text `[object ReadableStream]` — the silent
      // failure: a 200 carrying corrupt data.
      expect(seen).toEqual({ hello: "firefox" });
    });

    it("passes an empty body through rather than dropping it", async () => {
      restore = withoutRequestStreams();
      let seen: string | undefined;
      const stub = newHttpServerStub(async (request) => {
        seen = await (request as unknown as NoStreamsRequest).text();
        return new Response("ok");
      });

      await stub(requestEnvelope("POST"));
      expect(seen).toBe("");
    });

    it.each(["GET", "HEAD", "OPTIONS"])("builds no body for %s", async (method) => {
      restore = withoutRequestStreams();
      let seen: string | undefined;
      const stub = newHttpServerStub(async (request) => {
        seen = await (request as unknown as NoStreamsRequest).text();
        return new Response(null, { status: 204 });
      });

      await stub(requestEnvelope(method, ["ignored"]));

      expect(seen).toBe("");
    });

    it("still streams the request body into the handler when the runtime supports it", async () => {
      // No stand-in: the handler must see a live `request.body`, not a buffer.
      const chunks: string[] = [];
      const stub = newHttpServerStub(async (request) => {
        expect(request.body).not.toBeNull();
        const reader = (request.body as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) chunks.push(decoder.decode(value));
        }
        return new Response("ok");
      });

      const result = await stub(requestEnvelope("POST", ["first-", "second"]));

      expect(await collect(result.content)).toBe("ok");
      expect(chunks.join("")).toBe("first-second");
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});
