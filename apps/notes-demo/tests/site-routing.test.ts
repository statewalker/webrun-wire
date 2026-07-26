import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { describe, expect, it } from "vitest";

/**
 * Guards the D5 endpoint pattern: SiteBuilder matches by URLPattern over the
 * whole pathname, so endpoints are registered as `/api/*` (specific, first) and
 * `/*` (catch-all → module server). `/api/notes` must hit the API endpoint and
 * `/~/client/index.html` must fall through to the module-server handler.
 */

function buildHandler() {
  return new SiteBuilder()
    .setEndpoint("/api/*", () => new Response("api"))
    .setEndpoint("/*", () => new Response("modules"))
    .build();
}

const get = (handler: (r: Request) => Promise<Response>, path: string) =>
  handler(new Request(`http://site.local${path}`));

describe("site routing (D5 pattern)", () => {
  it("routes /api/notes to the API endpoint", async () => {
    const handler = buildHandler();
    expect(await (await get(handler, "/api/notes")).text()).toBe("api");
    expect(await (await get(handler, "/api/notes/abc")).text()).toBe("api");
  });

  it("routes module-server URLs to the catch-all", async () => {
    const handler = buildHandler();
    expect(await (await get(handler, "/~/client/index.html")).text()).toBe("modules");
    expect(await (await get(handler, "/react@18.3.1/index.js")).text()).toBe("modules");
    expect(await (await get(handler, "/")).text()).toBe("modules");
  });

  it("respects precedence: /api/* is matched before the catch-all", async () => {
    // Registering the catch-all first would swallow /api — order matters.
    const wrong = new SiteBuilder()
      .setEndpoint("/*", () => new Response("modules"))
      .setEndpoint("/api/*", () => new Response("api"))
      .build();
    expect(await (await get(wrong, "/api/notes")).text()).toBe("modules");
  });
});
