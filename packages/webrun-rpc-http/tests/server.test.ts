import { describe, expect, it } from "vitest";
import { newRpcServer } from "../src/new-rpc-server.js";

const services = {
  math: {
    async add(params: { a: number; b: number }) {
      return params.a + params.b;
    },
    async fail() {
      throw new Error("boom");
    },
    async asBytes(params: { bytes: number[] }) {
      return new Blob([new Uint8Array(params.bytes)]);
    },
    async echoBody(_params: unknown, body?: Blob) {
      if (!body) throw new Error("missing body");
      return new Blob([await body.arrayBuffer()]);
    },
    async echoPath(params: { $path?: string }) {
      return params.$path ?? "";
    },
  },
};

describe("newRpcServer", () => {
  it("GET / returns the full service descriptor", async () => {
    const handler = newRpcServer(services);
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      math: ["add", "fail", "asBytes", "echoBody", "echoPath"],
    });
  });

  it("GET /{service} lists methods for that service", async () => {
    const handler = newRpcServer(services);
    const res = await handler(new Request("http://x/math"));
    expect(await res.json()).toEqual(["add", "fail", "asBytes", "echoBody", "echoPath"]);
  });

  it("GET /{service}/{method}?a=1&b=2 decodes query params", async () => {
    const handler = newRpcServer(services);
    const res = await handler(new Request("http://x/math/add?a=1&b=2"));
    const json = (await res.json()) as { type: string; result: unknown };
    expect(json).toEqual({ type: "json", result: "12" });
    // NB: URLSearchParams are strings — method receives "1" + "2".
  });

  it("expands dot-separated query keys into nested objects", async () => {
    const handler = newRpcServer({
      math: {
        async inspect(params: unknown) {
          return params as never;
        },
      },
    });
    const res = await handler(new Request("http://x/math/inspect?a.b=c&a.d=e"));
    const json = (await res.json()) as { result: { a: { b: string; d: string } } };
    expect(json.result.a).toEqual({ b: "c", d: "e" });
  });

  it("POST multipart/form-data decodes JSON params and Blob body", async () => {
    const handler = newRpcServer(services);
    const form = new FormData();
    form.append("params", JSON.stringify({ ignored: true }));
    form.append("body", new Blob([new Uint8Array([1, 2, 3])]));
    const res = await handler(
      new Request("http://x/math/echoBody", { method: "POST", body: form }),
    );
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("propagates sub-path as params.$path", async () => {
    const handler = newRpcServer(services);
    const res = await handler(new Request("http://x/math/echoPath/foo/bar"));
    expect(await res.json()).toEqual({ type: "json", result: "foo/bar" });
  });

  it("wraps method errors in a {type:'error'} JSON body (status 200)", async () => {
    const handler = newRpcServer(services);
    const form = new FormData();
    form.append("params", JSON.stringify({}));
    const res = await handler(new Request("http://x/math/fail", { method: "POST", body: form }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: string; message: string };
    expect(json.type).toBe("error");
    expect(json.message).toBe("boom");
  });

  it("returns 500 JSON error when the method is unknown", async () => {
    const handler = newRpcServer(services);
    const form = new FormData();
    form.append("params", JSON.stringify({}));
    const res = await handler(new Request("http://x/math/nope", { method: "POST", body: form }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { type: string; message: string };
    expect(json.type).toBe("error");
    expect(json.message).toMatch(/Method nope not found/);
  });

  it("serves under a custom path prefix and ignores unrelated requests", async () => {
    const handler = newRpcServer(services, { path: "/api" });
    const inside = await handler(new Request("http://x/api/"));
    const body = (await inside.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("math");

    const outside = await handler(new Request("http://x/other"));
    expect(outside.status).toBe(404);
  });

  it("matches the path prefix on a segment boundary only", async () => {
    const handler = newRpcServer(services, { path: "/api/v1" });
    expect((await handler(new Request("http://x/api/v1"))).status).toBe(200);
    expect((await handler(new Request("http://x/api/v1?a=1"))).status).toBe(200);
    expect((await handler(new Request("http://x/api/v1/math"))).status).toBe(200);
    expect((await handler(new Request("http://x/api/v1x"))).status).toBe(404);
    expect((await handler(new Request("http://x/api/v1x/math"))).status).toBe(404);
  });

  it("picks up methods from class prototypes", async () => {
    class Greeter {
      async hello(params: { name: string }) {
        return `hello, ${params.name}`;
      }
    }
    const handler = newRpcServer({ greeter: new Greeter() });
    const res = await handler(new Request("http://x/greeter/hello?name=world"));
    expect(await res.json()).toEqual({ type: "json", result: "hello, world" });
  });
});
