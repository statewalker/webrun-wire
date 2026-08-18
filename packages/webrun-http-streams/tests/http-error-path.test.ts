import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import { PEER_ERROR_HEADER } from "../src/http-data.js";
import { httpCodec } from "../src/http1/index.js";
import { fetchOverDuplex, httpFetch, httpServe, serveFetchOverDuplex } from "../src/index.js";
import type { DecodedResponse, MessageCodec, RequestEnvelope } from "../src/message.js";

const loopback =
  (handler: Duplex): Duplex =>
  (input) =>
    handler(input);

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("handler errors under HTTP framing", () => {
  it("still rejects on the caller, with the peer's message", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("boom");
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toThrow(/boom/);
  });

  it("puts a conforming 500 on the wire, which a real peer could read", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("boom");
      }),
    );
    const wire = call(
      httpCodec.encodeRequest({ url: "http://h.test/x", method: "GET", headers: [] }),
    );
    const decoded = await httpCodec.decodeResponse(wire, { method: "GET" });
    expect(decoded.envelope.status).toBe(500);
    expect(decoded.envelope.statusText).toBe("Internal Server Error");
    expect(await text(decoded.body)).toContain("boom");
  });

  it("preserves the error name across peers", async () => {
    const call = loopback(
      httpServe(async () => {
        const err = new Error("nope");
        err.name = "CustomError";
        throw err;
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toMatchObject({ name: "CustomError", message: "nope" });
  });

  it("survives a non-ASCII error message", async () => {
    const call = loopback(
      httpServe(async () => {
        throw new Error("echec du a un probleme éàü");
      }),
    );
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }),
    ).rejects.toThrow(/éàü/);
  });

  it("propagates through the fetch layer too", async () => {
    const call = loopback(
      serveFetchOverDuplex(async () => {
        throw new Error("handler exploded");
      }),
    );
    await expect(fetchOverDuplex(call, new Request("https://example.test/x"))).rejects.toThrow(
      /handler exploded/,
    );
  });
});

describe("peer-error response body is actually drained", () => {
  it("runs the response body's own cleanup, not just .return() on a never-started generator", async () => {
    // A body whose `finally` marks itself released — proves `discard()` (used
    // by `throwIfPeerError`) actually started the generator before returning
    // it. `.return()` alone on a generator still in suspended start is a
    // documented JS no-op: none of the generator's code, including this
    // `finally`, would ever execute — which is exactly the bug under test.
    // A custom codec isolates this from HTTP/1.1's own chunked-decode
    // internals (a separate, lower-level concern from what `throwIfPeerError`
    // is responsible for): it hands `throwIfPeerError` a body it controls
    // directly, so this test is a property of `discard()` and its call site,
    // not of how any particular wire format happens to frame a body.
    const released = { value: false };
    async function* bodyWithFinally(): AsyncGenerator<Uint8Array> {
      try {
        yield new TextEncoder().encode("unused");
      } finally {
        released.value = true;
      }
    }

    const fakeCodec: MessageCodec = {
      name: "fake",
      sniff: () => true,
      encodeRequest: () => (async function* () {})(),
      encodeResponse: () => (async function* () {})(),
      decodeRequest: async () => ({
        envelope: { url: "/", method: "GET", headers: [] } as RequestEnvelope,
        body: (async function* () {})(),
      }),
      decodeResponse: async (): Promise<DecodedResponse> => ({
        envelope: {
          status: 500,
          statusText: "Internal Server Error",
          headers: [[PEER_ERROR_HEADER, JSON.stringify({ message: "boom" })]],
        },
        body: bodyWithFinally(),
      }),
    };

    const call: Duplex = () => (async function* () {})();
    await expect(
      httpFetch(call, { url: "http://h.test/x", method: "GET", headers: [] }, undefined, {
        codec: fakeCodec,
      }),
    ).rejects.toThrow(/boom/);
    expect(released.value).toBe(true);
  });
});

describe("codec selection", () => {
  it("a client and server both pinned to the legacy codec interoperate", async () => {
    const call = loopback(
      httpServe(
        async () => ({
          envelope: { status: 200, statusText: "OK", headers: [] },
          body: [new TextEncoder().encode("legacy")],
        }),
        { codec: jsonEnvelopeCodec },
      ),
    );
    const { body } = await httpFetch(call, { url: "/x", method: "GET", headers: [] }, undefined, {
      codec: jsonEnvelopeCodec,
    });
    expect(await text(body)).toBe("legacy");
  });

  it("a legacy-pinned client reaches a default server and is answered in kind", async () => {
    const call = loopback(
      httpServe(async (env) => ({
        envelope: { status: 200, statusText: "OK", headers: [] },
        body: [new TextEncoder().encode(`saw ${env.method}`)],
      })),
    );
    const { body } = await httpFetch(call, { url: "/x", method: "GET", headers: [] }, undefined, {
      codec: jsonEnvelopeCodec,
    });
    expect(await text(body)).toBe("saw GET");
  });
});
