import { describe, expect, it, vi } from "vitest";
import { newRpcClient } from "../src/new-rpc-client.js";

function mockResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  const { status = 200, contentType = "application/json" } = init;
  const payload = body instanceof Blob || typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload as BodyInit, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("newRpcClient", () => {
  it("loads the descriptor once and caches it across loadService calls", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/") {
        return mockResponse({ math: ["add"] });
      }
      return mockResponse({ type: "json", result: 42 });
    });
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    const svc1 = await client.loadService<{ add: (p: unknown) => Promise<unknown> }>("math");
    const svc2 = await client.loadService<{ add: (p: unknown) => Promise<unknown> }>("math");
    expect(svc1).toBe(svc2);
    // Only the descriptor call so far.
    expect(fetch).toHaveBeenCalledTimes(1);
    await svc1.add({ a: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws if the requested service is not in the descriptor", async () => {
    const fetch = vi.fn(async () => mockResponse({}));
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    await expect(client.loadService("missing")).rejects.toThrow("Service missing not found");
  });

  it("POSTs params and body as multipart/form-data", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/") {
        return mockResponse({ math: ["do"] });
      }
      expect(request.method).toBe("POST");
      const contentType = request.headers.get("Content-Type") || "";
      expect(contentType).toMatch(/^multipart\/form-data/);
      const form = await request.formData();
      expect(JSON.parse(form.get("params") as string)).toEqual({ hello: "world" });
      const body = form.get("body") as Blob;
      expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
      return mockResponse({ type: "json", result: "ok" });
    });
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    const svc = await client.loadService<{
      do: (p: unknown, body?: Blob) => Promise<unknown>;
    }>("math");
    const result = await svc.do({ hello: "world" }, new Blob([new Uint8Array([9, 9, 9])]));
    expect(result).toBe("ok");
  });

  it("returns a Blob when the response is binary", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/") {
        return mockResponse({ math: ["bytes"] });
      }
      return mockResponse(new Blob([new Uint8Array([1, 2, 3])]), {
        contentType: "application/octet-stream",
      });
    });
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    const svc = await client.loadService<{ bytes: (p: unknown) => Promise<Blob> }>("math");
    const result = await svc.bytes({});
    expect(result).toBeInstanceOf(Blob);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws a deserialized error when the response has type:'error'", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/") {
        return mockResponse({ math: ["fail"] });
      }
      return mockResponse({ type: "error", message: "server exploded", stack: "..." });
    });
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    const svc = await client.loadService<{ fail: (p: unknown) => Promise<unknown> }>("math");
    await expect(svc.fail({})).rejects.toThrow("server exploded");
  });

  it("throws when the descriptor request fails", async () => {
    const fetch = vi.fn(async () =>
      mockResponse("oops", { status: 503, contentType: "text/plain" }),
    );
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    await expect(client.loadService("math")).rejects.toThrow(/Failed to load services descriptor/);
  });

  it("retries the descriptor after a failed load instead of caching the failure", async () => {
    let up = false;
    const fetch = vi.fn(async (request: Request) => {
      if (!up) throw new TypeError("connection refused");
      if (new URL(request.url).pathname === "/") return mockResponse({ math: ["add"] });
      return mockResponse({ type: "json", result: 3 });
    });
    const client = newRpcClient({ baseUrl: "http://host", fetch });
    await expect(client.loadService("math")).rejects.toThrow("connection refused");
    up = true;
    const math = await client.loadService<{ add: (p: unknown) => Promise<unknown> }>("math");
    expect(await math.add({ a: 1, b: 2 })).toBe(3);
    // A successful load is still cached.
    await client.loadService("math");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
