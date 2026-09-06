/**
 * Compiles and runs every executable snippet in README.md, so a documented API
 * shape cannot drift from the real one without this failing. Mirrors
 * `webrun-streams/tests/readme-examples.test.ts`.
 */
import type { Duplex, Serve } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import {
  DuplexSiteBuilder,
  decodeMessage,
  defaultCodec,
  encodeMessage,
  fetchOverDuplex,
  HttpError,
  HttpParseError,
  httpCodec,
  httpFetch,
  httpServe,
  jsonEnvelopeCodec,
  newHttpClientStub,
  newHttpCodec,
  newHttpServerStub,
  newSniffingCodec,
  PEER_ERROR_HEADER,
  serveFetchOverDuplex,
} from "../src/index.js";

/** Run one request through a server `Duplex` and return the raw response bytes. */
async function readWire(
  handler: Duplex,
  request = "GET / HTTP/1.1\r\nHost: x\r\n\r\n",
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of handler([new TextEncoder().encode(request)])) chunks.push(c);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("README: data layer", () => {
  it("runs exactly as written", async () => {
    const call = httpServe(async (env, body) => {
      for await (const _chunk of body) {
        /* drain the request body */
      }
      return {
        envelope: { status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] },
        body: [new TextEncoder().encode(`hello ${new URL(env.url).pathname}`)],
      };
    });

    const { envelope, body } = await httpFetch(call, {
      url: "http://peer.test/api/time",
      method: "GET",
      headers: [],
    });
    expect(envelope.status).toBe(200);
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("hello /api/time");
  });

  it("a relative url arrives as http://localhost/api/time", async () => {
    const call = httpServe(async (env) => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [new TextEncoder().encode(env.url)],
    }));
    const { body } = await httpFetch(call, { url: "/api/time", method: "GET", headers: [] });
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("http://localhost/api/time");
  });
});

describe("README: fetch layer", () => {
  it("runs exactly as written", async () => {
    const call = serveFetchOverDuplex(
      async (request) => new Response(`hello ${new URL(request.url).pathname}`),
    );
    const response = await fetchOverDuplex(call, new Request("http://peer.test/api/time"));
    expect(await response.text()).toBe("hello /api/time");
  });

  it("strips hop-by-hop headers", async () => {
    const call = serveFetchOverDuplex(async (request) =>
      Response.json({ connection: request.headers.get("connection") }),
    );
    const res = await fetchOverDuplex(call, new Request("http://peer.test/x"));
    expect(await res.json()).toEqual({ connection: null });
  });

  it("request.signal aborts the call", async () => {
    const call = serveFetchOverDuplex(async () => new Response("x"));
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchOverDuplex(call, new Request("http://peer.test/x", { signal: ac.signal })),
    ).rejects.toThrow();
  });
});

describe("README: DuplexSiteBuilder", () => {
  // `webrun-rpc` is not a dependency of this package, so the README's
  // MessagePort snippet cannot be run from here. This substitutes the smallest
  // possible `Serve<P>` to prove the `start(serve, params)` shape and that the
  // handler is reached.
  it("start(serve, params) hands the site handler to the adapter", async () => {
    const siteHandler = async (request: Request): Promise<Response> =>
      new Response(`site ${new URL(request.url).pathname}`);

    let registered: Duplex | undefined;
    const serve: Serve<{ label: string }> = async (_params, handler) => {
      registered = handler;
      return async () => {
        registered = undefined;
      };
    };

    const stop = await new DuplexSiteBuilder()
      .setHandler(siteHandler)
      .start(serve, { label: "test" });

    expect(registered).toBeTypeOf("function");
    const res = await fetchOverDuplex(registered as Duplex, new Request("http://peer.test/hello"));
    expect(await res.text()).toBe("site /hello");
    await stop();
    expect(registered).toBeUndefined();
  });

  it("start() without setHandler throws", async () => {
    const serve: Serve<undefined> = async () => async () => {};
    await expect(new DuplexSiteBuilder().start(serve, undefined)).rejects.toThrow(
      "setHandler(handler) must be called before start()",
    );
  });
});

describe("README: stubs", () => {
  it("runs exactly as written", async () => {
    const server = newHttpServerStub(
      async (request) => new Response(`echo ${await request.text()}`),
    );
    const client = newHttpClientStub(server);

    const res = await client(new Request("http://peer.test/x", { method: "POST", body: "hi" }));
    expect(await res.text()).toBe("echo hi");
  });

  it("an undefined send result becomes a 404", async () => {
    const client = newHttpClientStub(async () => undefined);
    const res = await client(new Request("http://peer.test/x"));
    expect(res.status).toBe(404);
  });
});

describe("README: bodyless messages", () => {
  it.each([204, 205, 304])("status %i carries no body", async (status) => {
    const call = serveFetchOverDuplex(async () => new Response(null, { status }));
    const res = await fetchOverDuplex(call, new Request("http://peer.test/x"));
    expect(res.status).toBe(status);
    expect(res.body).toBe(null);
  });

  it("101 and 103 are in the set but a Response cannot carry them", async () => {
    for (const status of [101, 103]) {
      const call = httpServe(async () => ({
        envelope: { status, statusText: "S", headers: [] },
      }));
      await expect(fetchOverDuplex(call, new Request("http://p/x"))).rejects.toThrow(
        /must be in the range of 200 to 599/,
      );
    }
  });

  it.each(["HEAD", "OPTIONS"])("%s carries no body even when the handler yields one", async (m) => {
    const call = serveFetchOverDuplex(async () => new Response("ignored"));
    const res = await fetchOverDuplex(call, new Request("http://peer.test/x", { method: m }));
    expect(res.status).toBe(200);
    expect(res.body).toBe(null);
  });
});

describe("README: codecs", () => {
  it("scheme/host options are honoured", async () => {
    const codec = newHttpCodec({ scheme: "https", host: "peer.test" });
    const call = serveFetchOverDuplex(async (req) => new Response(req.url), { codec });
    const res = await fetchOverDuplex(call, new Request("https://peer.test/p"), { codec });
    expect(await res.text()).toBe("https://peer.test/p");
  });

  it("the documented defaults are the real ones", async () => {
    const call = httpServe(async (env) => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
      body: [new TextEncoder().encode(env.url)],
    }));
    const { body } = await httpFetch(call, { url: "/x", method: "GET", headers: [] }, undefined, {
      codec: newHttpCodec(),
    });
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    // scheme "http" + host "localhost"
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("http://localhost/x");
    expect(httpCodec.name).toBe("http/1.1");
    // maxHeaderBytes default 65536: a larger head is refused by the peer
    const call2 = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
    }));
    const err = await httpFetch(call2, {
      url: "/x",
      method: "GET",
      headers: [["x-big", "x".repeat(70000)]],
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: Error) => e,
    );
    expect(err.name).toBe("HttpParseError");
    expect(err.message).toMatch(/exceeds 65536/);
  });

  it("defaultCodec is sniff(write=http/1.1; accept=http/1.1,json-envelope)", () => {
    expect(defaultCodec.name).toBe(
      newSniffingCodec({ write: httpCodec, accept: [httpCodec, jsonEnvelopeCodec] }).name,
    );
    expect(defaultCodec.name).toBe("sniff(write=http/1.1; accept=http/1.1,json-envelope)");
  });

  it("a legacy-envelope caller is answered as a legacy envelope", async () => {
    const call = serveFetchOverDuplex(async () => new Response("ok"));
    const res = await fetchOverDuplex(call, new Request("http://peer.test/x"), {
      codec: jsonEnvelopeCodec,
    });
    expect(await res.text()).toBe("ok");
  });

  it("encodeMessage / decodeMessage round-trip", async () => {
    const { envelope, body } = await decodeMessage<{ a: number }>(
      encodeMessage({ a: 1 }, [new TextEncoder().encode("bytes")]),
    );
    expect(envelope).toEqual({ a: 1 });
    const chunks: Uint8Array[] = [];
    for await (const c of body) chunks.push(c);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("bytes");
  });
});

describe("README: errors", () => {
  it("a LOCAL refusal is a real HttpParseError instance", async () => {
    const badServer = async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("!!! not http\r\n\r\n");
    };
    const err = await httpFetch(badServer, {
      url: "http://p/x",
      method: "GET",
      headers: [],
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(HttpParseError);
    expect(err.name).toBe("HttpParseError");
  });

  it("a REMOTE refusal keeps the name but NOT the class", async () => {
    const server = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
    }));
    const err = await httpFetch(server, {
      url: "/x",
      method: "GET",
      headers: [["x-big", "x".repeat(70000)]],
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: Error) => e,
    );
    expect(err.name).toBe("HttpParseError");
    expect(err).not.toBeInstanceOf(HttpParseError);
  });

  it("a handler throw rejects with the peer's error, custom fields preserved", async () => {
    class NotFound extends Error {
      status = 404;
    }
    const call = httpServe(async () => {
      throw new NotFound("missing");
    });
    await expect(
      httpFetch(call, { url: "http://p/x", method: "GET", headers: [] }),
    ).rejects.toMatchObject({ message: "missing", status: 404 });
  });

  it("PEER_ERROR_HEADER is x-webrun-error and bounded at 4096 chars", async () => {
    expect(PEER_ERROR_HEADER).toBe("x-webrun-error");
    const wire = await readWire(
      httpServe(async () => {
        throw new Error("m".repeat(100_000));
      }),
    );
    expect(wire).toContain("HTTP/1.1 500 Internal Server Error");
    const header = /^x-webrun-error: (.*)$/im.exec(wire)?.[1] ?? "";
    expect(header.length).toBeGreaterThan(0);
    expect(header.length).toBeLessThanOrEqual(4096);
  });

  it("throwing an HttpError produces a 500 like any other exception", async () => {
    const wire = await readWire(
      httpServe(async () => {
        throw HttpError.errorResourceNotFound();
      }),
    );
    expect(wire).toContain("HTTP/1.1 500 Internal Server Error");
  });

  it("a leading CRLF is refused as a malformed request line (400)", async () => {
    const handler = httpServe(async () => ({
      envelope: { status: 200, statusText: "OK", headers: [] },
    }));
    const wire = await readWire(handler, "\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(wire).toContain("HTTP/1.1 400 Bad Request");
    expect(wire.toLowerCase()).toContain("x-webrun-error:");
  });
});
