import { describe, expect, it } from "vitest";
import { HostedSiteBuilder, newServerRunner } from "../src/hosted-site-builder.js";
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
    const site = await builder.setHandler(async () => new Response("")).build();
    expect(site.siteKey).toBe("abc");
    expect(site.baseUrl).toBe(`${FakeAdapter.ORIGIN}/abc/`);
    expect(typeof site.stop).toBe("function");
  });

  it("auto-generates a UUID site key when not set", async () => {
    const site = await new HostedSiteBuilder({
      adapterFactory: (opts) => new FakeAdapter(opts),
    })
      .setHandler(async () => new Response(""))
      .build();
    expect(site.siteKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("build() throws when setHandler was not called", async () => {
    const builder = new HostedSiteBuilder({
      adapterFactory: (opts) => new FakeAdapter(opts),
    });
    await expect(builder.build()).rejects.toThrow(/setHandler/);
  });

  it("dispatches every request through the registered handler", async () => {
    const seen: string[] = [];
    const { builder, getAdapter } = newBuilder();
    builder.setHandler(async (request) => {
      seen.push(request.url);
      return new Response("ok");
    });
    await builder.build();
    const response = await getAdapter().dispatch("/api/x");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(seen).toEqual(["http://site.local/api/x"]);
  });

  it("rewrites SW-scope URLs into site-local URLs before invoking the handler", async () => {
    const { builder, getAdapter } = newBuilder("abc");
    builder.setHandler(async (request) => Response.json({ url: request.url }));
    await builder.build();
    const response = await getAdapter().dispatch("/seen");
    expect(((await response.json()) as { url: string }).url).toBe("http://site.local/seen");
  });

  it("HostedSite.stop() removes the registration AND stops the adapter", async () => {
    const { builder, getAdapter } = newBuilder();
    const site = await builder.setHandler(async () => new Response("pong")).build();
    expect(getAdapter().handler).toBeDefined();
    expect(getAdapter().handlerRemoved).toBe(false);
    expect(getAdapter().stopped).toBe(false);
    await site.stop();
    expect(getAdapter().handler).toBeUndefined();
    expect(getAdapter().handlerRemoved).toBe(true);
    expect(getAdapter().stopped).toBe(true);
  });

  it("HostedSite.stop() tolerates adapters without a stop() method", async () => {
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
      .setHandler(async () => new Response("pong"))
      .build();
    await expect(site.stop()).resolves.toBeUndefined();
    expect(captured?.removed).toBe(true);
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
      .setHandler(async () => new Response(""))
      .build();
    expect(seen).toEqual({ key: "k1", serviceWorkerUrl: "http://host/custom-sw.js" });
  });

  it("newServerRunner: imported module receives runner env + per-request params", async () => {
    const moduleSrc = `export default (request, env) => Response.json({
      params: env.params,
      db: env.db,
      region: env.region,
      url: request.url,
    });`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(moduleSrc).toString("base64")}`;
    const runner = newServerRunner("", () => dataUrl, { db: "main", region: "eu" });

    const response = await runner(new Request("http://site.local/items/42"), {
      params: { id: "42" },
    });
    expect(await response.json()).toEqual({
      params: { id: "42" },
      db: "main",
      region: "eu",
      url: "http://site.local/items/42",
    });
  });

  it("newServerRunner: per-request params win over runner env keyed `params`", async () => {
    const moduleSrc = "export default (_req, env) => Response.json({ params: env.params });";
    const dataUrl = `data:text/javascript;base64,${Buffer.from(moduleSrc).toString("base64")}`;
    const runner = newServerRunner("", () => dataUrl, {
      params: { id: "should-be-overwritten" },
    });
    const response = await runner(new Request("http://x/items/9"), {
      params: { id: "9" },
    });
    expect(await response.json()).toEqual({ params: { id: "9" } });
  });
});
