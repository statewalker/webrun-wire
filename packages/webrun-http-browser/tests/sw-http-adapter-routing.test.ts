/**
 * Which of a page's handlers answers a request: `SwHttpAdapter.register`
 * prefixes, routed with no ServiceWorker involved (the adapter's own
 * dispatch, called directly).
 */
import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { describe, expect, it } from "vitest";
import { SwHttpAdapter } from "../src/sw/sw-http-adapter.js";

function newAdapter(): SwHttpAdapter {
  return new SwHttpAdapter({ key: "demo", serviceWorkerUrl: "https://app.example/sw.js" });
}

function answering(body: string): HttpHandler {
  return async () => new Response(body);
}

async function dispatch(adapter: SwHttpAdapter, url: string): Promise<Response> {
  const handle = (
    adapter as unknown as { _handleHttpRequest(request: Request): Promise<Response> }
  )._handleHttpRequest.bind(adapter);
  return await handle(new Request(url));
}

describe("SwHttpAdapter routing", () => {
  it("routes to the longest matching prefix, whatever the registration order", async () => {
    const adapter = newAdapter();
    await adapter.register("demo/", answering("outer"));
    await adapter.register("demo/api/", answering("inner"));
    expect(await (await dispatch(adapter, "https://app.example/demo/api/x")).text()).toBe("inner");
    expect(await (await dispatch(adapter, "https://app.example/demo/x")).text()).toBe("outer");
  });

  it("matches a prefix only on a segment boundary", async () => {
    const adapter = newAdapter();
    await adapter.register("demo/api", answering("api"));
    expect(await (await dispatch(adapter, "https://app.example/demo/api")).text()).toBe("api");
    expect(await (await dispatch(adapter, "https://app.example/demo/api/x")).text()).toBe("api");
    expect(await (await dispatch(adapter, "https://app.example/demo/api?q=1")).text()).toBe("api");
    expect((await dispatch(adapter, "https://app.example/demo/apiary")).status).toBe(404);
  });

  it("remove() of an earlier registration leaves a newer one of the same prefix", async () => {
    const adapter = newAdapter();
    const first = await adapter.register("demo/api/", answering("first"));
    const second = await adapter.register("demo/api/", answering("second"));
    await first.remove();
    expect(await (await dispatch(adapter, "https://app.example/demo/api/x")).text()).toBe("second");
    await second.remove();
    expect((await dispatch(adapter, "https://app.example/demo/api/x")).status).toBe(404);
  });
});
