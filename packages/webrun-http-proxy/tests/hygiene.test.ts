/**
 * Response hygiene, configuration failures and the safer defaults, in Node,
 * against a real upstream where the platform's `fetch` behaviour matters
 * (content decoding, real 3xx answers).
 */

import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKER, urlUpstream } from "../src/proxy.js";

const PLAIN = "hello, decoded world!\n".repeat(20);

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/gzip") {
      const zipped = gzipSync(PLAIN);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-length": String(zipped.byteLength),
        "x-kept": "yes",
      });
      res.end(zipped);
      return;
    }
    if (url.pathname === "/echo") {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "upstream-session=planted; Path=/",
      });
      res.end(JSON.stringify({ headers }));
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "http://upstream.internal/elsewhere" });
      res.end();
      return;
    }
    if (url.pathname === "/not-modified") {
      res.writeHead(304, { etag: '"v1"' });
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("response headers", () => {
  it("drops content-encoding and content-length when fetch has decoded the body (gzip upstream)", async () => {
    const res = await urlUpstream({ base: origin })(new Request("http://in/gzip"));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe(PLAIN);
    expect(res.headers.get("content-encoding")).toBeNull();
    const length = res.headers.get("content-length");
    if (length !== null) expect(Number(length)).toBe(bytes.byteLength);
    expect(res.headers.get("x-kept")).toBe("yes");
  });

  it("drops hop-by-hop response headers, including those named in Connection", async () => {
    const res = await urlUpstream({ base: origin })(new Request("http://in/gzip"));
    await res.arrayBuffer();
    expect(res.headers.get("connection")).toBeNull();
    expect(res.headers.get("keep-alive")).toBeNull();
    expect(res.headers.get("transfer-encoding")).toBeNull();

    const fake = urlUpstream({
      base: "http://upstream.test",
      fetchImpl: async () =>
        new Response("ok", {
          headers: { connection: "x-private, close", "x-private": "1", "x-public": "2" },
        }),
    });
    const faked = await fake(new Request("http://in/x"));
    expect(faked.headers.get("x-private")).toBeNull();
    expect(faked.headers.get("connection")).toBeNull();
    expect(faked.headers.get("x-public")).toBe("2");
  });

  it("keeps content-encoding for a coding fetch does not decode", async () => {
    const res = await urlUpstream({
      base: "http://upstream.test",
      fetchImpl: async () =>
        new Response("raw", { headers: { "content-encoding": "x-custom", "content-length": "3" } }),
    })(new Request("http://in/x"));
    expect(res.headers.get("content-encoding")).toBe("x-custom");
    expect(res.headers.get("content-length")).toBe("3");
  });
});

describe("request headers named in Connection", () => {
  it("are not forwarded upstream", async () => {
    const res = await urlUpstream({ base: origin })(
      new Request("http://in/echo", {
        headers: { connection: "x-hop-only, keep-alive", "x-hop-only": "1", "x-end": "2" },
      }),
    );
    const { headers } = (await res.json()) as { headers: Record<string, string> };
    expect(headers["x-hop-only"]).toBeUndefined();
    expect(headers["x-end"]).toBe("2");
  });
});

describe("configuration and credential failures answer 502", () => {
  const call = (init: Parameters<typeof urlUpstream>[0]) =>
    urlUpstream({ fetchImpl: async () => new Response("unreached"), ...init })(
      new Request("http://in/x"),
    );

  it("a credential value that is not a valid header value", async () => {
    const res = await call({
      base: "http://upstream.test",
      credential: () => ({ authorization: "Bearer sk-\nSECRET" }),
    });
    expect(res.status).toBe(502);
    expect(res.headers.get(MARKER)).toBe("upstream-unreachable");
    // The rejected value is a credential: it must not be echoed to the caller.
    expect(await res.text()).not.toContain("SECRET");
  });

  it("a credential() that throws", async () => {
    const res = await call({
      base: "http://upstream.test",
      credential: () => {
        throw new Error("no API key configured");
      },
    });
    expect(res.status).toBe(502);
    expect(res.headers.get(MARKER)).toBe("upstream-unreachable");
  });

  it("an invalid base", async () => {
    const res = await call({ base: "not a url" });
    expect(res.status).toBe(502);
    expect(res.headers.get(MARKER)).toBe("upstream-unreachable");
  });
});

describe("cookies", () => {
  it("are neither forwarded nor returned by default", async () => {
    const res = await urlUpstream({ base: origin })(
      new Request("http://in/echo", { headers: { cookie: "proxy-session=mine" } }),
    );
    const { headers } = (await res.json()) as { headers: Record<string, string> };
    expect(headers.cookie).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("pass both ways with forwardCookies: true", async () => {
    const res = await urlUpstream({ base: origin, forwardCookies: true })(
      new Request("http://in/echo", { headers: { cookie: "app=1" } }),
    );
    const { headers } = (await res.json()) as { headers: Record<string, string> };
    expect(headers.cookie).toBe("app=1");
    expect(res.headers.get("set-cookie")).toBe("upstream-session=planted; Path=/");
  });
});

describe("redirects outside a browser", () => {
  it("a real 3xx redirect is reported as upstream-redirect, without its Location", async () => {
    const res = await urlUpstream({ base: origin })(new Request("http://in/redirect"));
    expect(res.status).toBe(502);
    expect(res.headers.get(MARKER)).toBe("upstream-redirect");
    expect(res.headers.get("location")).toBeNull();
  });

  it("304 Not Modified is not a redirect and passes through", async () => {
    const res = await urlUpstream({ base: origin })(
      new Request("http://in/not-modified", { headers: { "if-none-match": '"v1"' } }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get(MARKER)).toBeNull();
  });
});
