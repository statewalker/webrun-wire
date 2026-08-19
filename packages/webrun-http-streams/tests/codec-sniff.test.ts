import { describe, expect, it } from "vitest";
import { defaultCodec } from "../src/codec-default.js";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import { HttpParseError } from "../src/http1/errors.js";
import { httpCodec } from "../src/http1/index.js";
import { newSniffingCodec } from "../src/sniff.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("sniffing codec", () => {
  it("sniffs are mutually exclusive: '{' is not a token character", () => {
    expect(jsonEnvelopeCodec.sniff(0x7b)).toBe(true);
    expect(httpCodec.sniff(0x7b)).toBe(false);
    expect(httpCodec.sniff("G".charCodeAt(0))).toBe(true);
    expect(jsonEnvelopeCodec.sniff("G".charCodeAt(0))).toBe(false);
  });

  it("defaultCodec writes HTTP/1.1", async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of defaultCodec.encodeRequest({
      url: "http://h.test/x",
      method: "GET",
      headers: [],
    })) {
      chunks.push(c);
    }
    expect(new TextDecoder().decode(chunks[0])).toMatch(/^GET \/x HTTP\/1\.1\r\n/);
  });

  it("accepts a legacy JSON-envelope request from an un-upgraded peer", async () => {
    const legacy = jsonEnvelopeCodec.encodeRequest(
      { url: "/legacy", method: "POST", headers: [["a", "b"]] },
      [enc("payload")],
    );
    const decoded = await defaultCodec.decodeRequest(legacy);
    expect(decoded.envelope.url).toBe("/legacy");
    expect(await text(decoded.body)).toBe("payload");
  });

  it("accepts an HTTP/1.1 request", async () => {
    const decoded = await defaultCodec.decodeRequest(
      httpCodec.encodeRequest({ url: "http://h.test/x", method: "GET", headers: [] }),
    );
    expect(decoded.envelope.url).toBe("http://h.test/x");
  });

  it("accepts a legacy JSON-envelope response", async () => {
    const legacy = jsonEnvelopeCodec.encodeResponse(
      { status: 200, statusText: "OK", headers: [] },
      [enc("hi")],
    );
    const decoded = await defaultCodec.decodeResponse(legacy, { method: "GET" });
    expect(decoded.envelope.status).toBe(200);
    expect(await text(decoded.body)).toBe("hi");
  });

  it("refuses a first byte no accepted codec claims, as HttpParseError (I2)", async () => {
    await expect(defaultCodec.decodeRequest([new Uint8Array([0x00])])).rejects.toThrow(
      /no accepted codec/,
    );
    await expect(defaultCodec.decodeRequest([new Uint8Array([0x00])])).rejects.toThrow(
      HttpParseError,
    );
  });

  it("refuses an empty stream, as HttpParseError (I2)", async () => {
    await expect(defaultCodec.decodeRequest([])).rejects.toThrow(/ended before any bytes/);
    await expect(defaultCodec.decodeRequest([])).rejects.toThrow(HttpParseError);
  });

  it("can be configured to write the legacy format", async () => {
    const legacyWriter = newSniffingCodec({
      write: jsonEnvelopeCodec,
      accept: [httpCodec, jsonEnvelopeCodec],
    });
    const chunks: Uint8Array[] = [];
    for await (const c of legacyWriter.encodeRequest({ url: "/x", method: "GET", headers: [] })) {
      chunks.push(c);
    }
    expect(new TextDecoder().decode(chunks[0]).startsWith("{")).toBe(true);
  });
});
