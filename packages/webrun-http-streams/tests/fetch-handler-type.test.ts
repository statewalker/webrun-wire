import type { FetchHandler as EventsFetchHandler } from "@statewalker/webrun-http-events";
import type { FetchHandler as ProxyFetchHandler } from "@statewalker/webrun-http-proxy";
import { describe, expectTypeOf, it } from "vitest";
import type { FetchHandler, HttpHandler, SiteHandler } from "../src/index.js";

// One handler type across webrun-wire. webrun-http-proxy and webrun-http-events keep zero runtime
// dependencies, so they declare it themselves; TypeScript types are structural, and this check
// (run by `typecheck:tests`) keeps every declaration identical to this package's.
describe("FetchHandler", () => {
  it("is one type everywhere: sync or async, as a Service Worker's or a Durable Object's fetch", () => {
    expectTypeOf<FetchHandler>().toEqualTypeOf<
      (request: Request) => Response | Promise<Response>
    >();
    expectTypeOf<ProxyFetchHandler>().toEqualTypeOf<FetchHandler>();
    expectTypeOf<EventsFetchHandler>().toEqualTypeOf<FetchHandler>();
    expectTypeOf<HttpHandler>().toEqualTypeOf<FetchHandler>();
    expectTypeOf<SiteHandler>().toEqualTypeOf<FetchHandler>();
  });
});
