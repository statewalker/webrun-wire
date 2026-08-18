import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { jsonEnvelopeCodec } from "../src/envelope.js";
import { httpCodec } from "../src/http1/index.js";
import { fetchOverDuplex, httpFetch, httpServe, serveFetchOverDuplex } from "../src/index.js";

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
