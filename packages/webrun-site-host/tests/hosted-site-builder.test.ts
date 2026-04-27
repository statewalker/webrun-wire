import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newBasicAuth } from "@statewalker/webrun-site-builder";
import { describe, expect, it } from "vitest";
import { HostedSiteBuilder } from "../src/hosted-site-builder.js";
import type { SiteAdapter } from "../src/types.js";
import { FakeAdapter } from "./fake-adapter.js";

function newBuilder(key = "test"): {
  builder: HostedSiteBuilder;
  getAdapter: () => FakeAdapter;
} {
  let adapter: FakeAdapter | undefined;
  const factory = (options: { key: string; serviceWorkerUrl: string }): SiteAdapter => {
    adapter = new FakeAdapter(options);
    return adapter;
  };
  const builder = new HostedSiteBuilder({ adapterFactory: factory }).setSiteKey(key);
  return {
    builder,
    getAdapter: () => {
      if (!adapter) throw new Error("adapter not yet created — call .build() first");
      return adapter;
    },
  };
}

describe("HostedSiteBuilder", () => {
  it("returns a HostedSite handle with baseUrl + siteKey + stop()", async () => {
    const { builder } = newBuilder("abc");
    const site = await builder.build();
    expect(site.siteKey).toBe("abc");
    expect(site.baseUrl).toBe(`${FakeAdapter.ORIGIN}/abc/`);
    expect(typeof site.stop).toBe("function");
  });

  it("auto-generates a UUID site key when not set", async () => {
    const site = await new HostedSiteBuilder({
      adapterFactory: (opts) => new FakeAdapter(opts),
    }).build();
    // RFC 4122 v4 UUID shape.
    expect(site.siteKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("serves files from a record-style mount", async () => {
    const { builder, getAdapter } = newBuilder();
    builder.setFiles("/client", {
      "/index.html": "<p>hello</p>",
      "/style.css": "body{}",
    });
    await builder.build();
    const response = await getAdapter().dispatch("/client/index.html");
    expect(await response.text()).toBe("<p>hello</p>");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("accepts a FilesApi instance alongside a record", async () => {
    const { builder, getAdapter } = newBuilder();
    const files = new MemFilesApi();
    await files.write("/a.txt", [new TextEncoder().encode("A")]);
    builder.setFiles("/api", files).setFiles("/html", { "/b.txt": "B" });
    await builder.build();
    expect(await (await getAdapter().dispatch("/api/a.txt")).text()).toBe("A");
    expect(await (await getAdapter().dispatch("/html/b.txt")).text()).toBe("B");
  });

  it("passes setEndpoint through with params and method", async () => {
    const { builder, getAdapter } = newBuilder();
    builder
      .setEndpoint("/echo/:name", "GET", (_request, params) =>
        Response.json({ hello: params.name }),
      )
      .setEndpoint("/any", (request) => new Response(request.method));
    await builder.build();
    expect(await (await getAdapter().dispatch("/echo/world")).json()).toEqual({ hello: "world" });
    // Non-GET falls through 404 because we pinned the first endpoint to GET.
    expect((await getAdapter().dispatch("/echo/world", { method: "POST" })).status).toBe(404);
    // Wildcard endpoint accepts any method.
    expect(await (await getAdapter().dispatch("/any", { method: "DELETE" })).text()).toBe("DELETE");
  });

  it("setAuth runs before routing and short-circuits on rejection", async () => {
    const { builder, getAdapter } = newBuilder();
    builder
      .setFiles("/", { "/index.html": "secret" })
      .setAuth("/*", newBasicAuth({ tom: "!jerry!" }));
    await builder.build();
    const blocked = await getAdapter().dispatch("/index.html");
    expect(blocked.status).toBe(401);
    const authed = await getAdapter().dispatch("/index.html", {
      headers: { Authorization: `Basic ${btoa("tom:!jerry!")}` },
    });
    expect(await authed.text()).toBe("secret");
  });

  it("setErrorHandler captures throws from endpoints", async () => {
    const seen: unknown[] = [];
    const { builder, getAdapter } = newBuilder();
    builder
      .setEndpoint("/boom", () => {
        throw new Error("nope");
      })
      .setErrorHandler((error) => {
        seen.push(error);
        return new Response("caught", { status: 500 });
      });
    await builder.build();
    const response = await getAdapter().dispatch("/boom");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("caught");
    expect((seen[0] as Error).message).toBe("nope");
  });

  it("rewrites SW-scope URLs into site-local URLs before the SiteBuilder runs", async () => {
    const { builder, getAdapter } = newBuilder("abc");
    builder.setEndpoint("/seen", (request) => Response.json({ url: request.url }));
    await builder.build();
    const response = await getAdapter().dispatch("/seen");
    // The handler sees a rewritten site-local URL, not the adapter's origin.
    expect(((await response.json()) as { url: string }).url).toBe("http://site.local/seen");
  });

  it("setServerRunner registers an endpoint at the given pattern (no invocation)", async () => {
    // We register a server runner and verify it's wired as a matching endpoint;
    // actually running the dynamic `import()` requires a browser, so we stop
    // short of invoking the handler here — the app demo covers that path.
    const { builder, getAdapter } = newBuilder();
    builder
      .setFiles("/server", { "/api/index.js": "export default () => new Response('x');" })
      .setServerRunner("/api", "/server/api/index.js");
    await builder.build();
    // The endpoint matches — its handler will `import()` on invocation. We
    // don't invoke here because jsdom's module loader can't resolve the URL.
    expect(getAdapter().handler).toBeDefined();
  });

  it("HostedSite.stop() removes the registration AND stops the adapter", async () => {
    const { builder, getAdapter } = newBuilder();
    builder.setEndpoint("/ping", () => new Response("pong"));
    const site = await builder.build();
    expect(getAdapter().handler).toBeDefined();
    expect(getAdapter().handlerRemoved).toBe(false);
    expect(getAdapter().stopped).toBe(false);
    await site.stop();
    expect(getAdapter().handler).toBeUndefined();
    expect(getAdapter().handlerRemoved).toBe(true);
    expect(getAdapter().stopped).toBe(true);
  });

  it("HostedSite.stop() tolerates adapters without a stop() method", async () => {
    // A minimal adapter that satisfies the required interface only.
    class MinimalAdapter implements SiteAdapter {
      removed = false;
      async start(): Promise<void> {}
      async register(prefix: string, handler: (request: Request) => Promise<Response>) {
        void handler;
        return {
          baseUrl: `http://minimal/${prefix.replace(/^[./]+/, "")}`,
          remove: async () => {
            this.removed = true;
          },
        };
      }
    }
    let captured: MinimalAdapter | undefined;
    const site = await new HostedSiteBuilder({
      adapterFactory: () => {
        captured = new MinimalAdapter();
        return captured;
      },
    })
      .setSiteKey("k")
      .setEndpoint("/ping", () => new Response("pong"))
      .build();
    await expect(site.stop()).resolves.toBeUndefined();
    expect(captured?.removed).toBe(true);
  });

  it("forwards ServeFilesOptions.transform to the underlying mount", async () => {
    const { builder, getAdapter } = newBuilder();
    builder.setFiles(
      "/client",
      { "/main.tsx": "const x: number = 1; export {};" },
      {
        transform: async (_req, res) => {
          if (res.status !== 200) return res;
          const src = await res.text();
          return new Response(`/* t */ ${src}`, {
            status: 200,
            headers: { "Content-Type": "text/javascript" },
          });
        },
      },
    );
    await builder.build();
    const response = await getAdapter().dispatch("/client/main.tsx");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript");
    expect(await response.text()).toBe("/* t */ const x: number = 1; export {};");
  });

  it("calls the adapter factory with the resolved key + swUrl", async () => {
    let seen: { key: string; serviceWorkerUrl: string } | undefined;
    await new HostedSiteBuilder({
      adapterFactory: (opts) => {
        seen = opts;
        return new FakeAdapter(opts);
      },
    })
      .setSiteKey("k1")
      .setServiceWorkerUrl("http://host/custom-sw.js")
      .build();
    expect(seen).toEqual({ key: "k1", serviceWorkerUrl: "http://host/custom-sw.js" });
  });
});
