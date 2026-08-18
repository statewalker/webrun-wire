import { describe, expect, it } from "vitest";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import { httpCodec, newHttpCodec } from "../src/http1/index.js";
import type { MessageCodec, RequestEnvelope, ResponseEnvelope } from "../src/message.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

const CODECS: [string, MessageCodec][] = [
  ["http/1.1", httpCodec],
  ["json-envelope", jsonEnvelopeCodec],
];

describe.each(CODECS)("%s round-trip", (_name, codec) => {
  it("round-trips a request with a body", async () => {
    const env: RequestEnvelope = {
      url: "http://example.test/api?a=1&b=two&empty=",
      method: "POST",
      headers: [["X-Test", "yes"]],
    };
    const decoded = await codec.decodeRequest(codec.encodeRequest(env, [enc("hel"), enc("lo")]));
    expect(decoded.envelope.url).toBe(env.url);
    expect(decoded.envelope.method).toBe("POST");
    expect(await text(decoded.body)).toBe("hello");
  });

  it("round-trips a bodyless request", async () => {
    const env: RequestEnvelope = { url: "http://example.test/x", method: "GET", headers: [] };
    const decoded = await codec.decodeRequest(codec.encodeRequest(env));
    expect(decoded.envelope.url).toBe(env.url);
    expect(await text(decoded.body)).toBe("");
  });

  it("round-trips a response", async () => {
    const env: ResponseEnvelope = {
      status: 201,
      statusText: "Created",
      headers: [["Content-Type", "text/plain"]],
    };
    const decoded = await codec.decodeResponse(codec.encodeResponse(env, [enc("pong")]), {
      method: "POST",
    });
    expect(decoded.envelope.status).toBe(201);
    expect(decoded.envelope.statusText).toBe("Created");
    expect(await text(decoded.body)).toBe("pong");
  });
});

describe("httpCodec configuration", () => {
  it("reconstructs the configured scheme, which the wire does not carry", async () => {
    // The accepted cost of decision 6: scheme is ambient config, not wire data.
    const writer = newHttpCodec();
    const reader = newHttpCodec({ scheme: "https" });
    const decoded = await reader.decodeRequest(
      writer.encodeRequest({ url: "http://example.test/x", method: "GET", headers: [] }),
    );
    expect(decoded.envelope.url).toBe("https://example.test/x");
  });

  it("uses the configured host when the url is a bare path", async () => {
    const codec = newHttpCodec({ host: "peer.local" });
    const decoded = await codec.decodeRequest(
      codec.encodeRequest({ url: "/x", method: "GET", headers: [] }),
    );
    expect(decoded.envelope.url).toBe("http://peer.local/x");
  });
});
