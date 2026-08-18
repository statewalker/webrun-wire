import { describe, expect, it } from "vitest";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import type { RequestEnvelope } from "../src/message.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(iter: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of iter) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("jsonEnvelopeCodec", () => {
  it("declares its name and sniffs an opening brace", () => {
    expect(jsonEnvelopeCodec.name).toBe("json-envelope");
    expect(jsonEnvelopeCodec.sniff(0x7b)).toBe(true);
    expect(jsonEnvelopeCodec.sniff(0x47)).toBe(false);
  });

  it("round-trips a request through the codec surface", async () => {
    const env: RequestEnvelope = { url: "/x", method: "GET", headers: [["a", "b"]] };
    const wire = await collect(jsonEnvelopeCodec.encodeRequest(env, [enc("hi")]));
    expect(wire).toBe('{"url":"/x","method":"GET","headers":[["a","b"]]}\nhi');

    const decoded = await jsonEnvelopeCodec.decodeRequest([enc(wire)]);
    expect(decoded.envelope).toEqual(env);
    expect(await collect(decoded.body)).toBe("hi");
  });

  it("round-trips a response and ignores the method hint", async () => {
    const env = { status: 204, statusText: "No Content", headers: [] };
    const wire = await collect(
      jsonEnvelopeCodec.encodeResponse(env, undefined, { method: "HEAD" }),
    );
    const decoded = await jsonEnvelopeCodec.decodeResponse([enc(wire)], { method: "HEAD" });
    expect(decoded.envelope).toEqual(env);
    expect(await collect(decoded.body)).toBe("");
  });
});
