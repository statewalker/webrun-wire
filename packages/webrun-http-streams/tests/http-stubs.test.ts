import { describe, expect, it } from "vitest";
import { newHttpClientStub, newHttpServerStub } from "../src/http-stubs.js";

describe("http-stubs", () => {
  it("newHttpServerStub deserializes a Request and serializes the Response", async () => {
    const handler = async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("https://foo.bar/a");
      expect(request.headers.get("x-in")).toBe("yes");
      return new Response("ok", {
        status: 202,
        statusText: "Accepted",
        headers: { "x-out": "true", "content-type": "text/plain" },
      });
    };
    const stub = newHttpServerStub(handler);
    const result = await stub({
      options: {
        url: "https://foo.bar/a",
        method: "GET",
        headers: [["x-in", "yes"]],
      },
      content: (async function* () {})(),
    });
    expect(result.options.status).toBe(202);
    expect(result.options.statusText).toBe("Accepted");
    expect(result.options.headers["x-out"]).toBe("true");
    const decoder = new TextDecoder();
    const bytes: string[] = [];
    for await (const chunk of result.content) bytes.push(decoder.decode(chunk));
    expect(bytes.join("")).toBe("ok");
  });

  it("newHttpClientStub serializes a Request and deserializes the Response", async () => {
    const stub = newHttpClientStub(async (envelope) => {
      expect(envelope.options.url).toBe("https://foo.bar/b");
      expect(envelope.options.method).toBe("POST");
      const bytes: Uint8Array[] = [];
      for await (const chunk of envelope.content) bytes.push(chunk);
      const decoder = new TextDecoder();
      const body = bytes.map((b) => decoder.decode(b)).join("");
      expect(body).toBe("ping");
      const encoder = new TextEncoder();
      return {
        options: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        },
        content: (async function* () {
          yield encoder.encode("pong");
        })(),
      };
    });
    const response = await stub(
      new Request("https://foo.bar/b", {
        method: "POST",
        body: "ping",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
  });

  it("returns 404 when the transport resolves to undefined", async () => {
    const stub = newHttpClientStub(async () => undefined);
    const response = await stub(new Request("https://foo.bar/missing"));
    expect(response.status).toBe(404);
  });
});
