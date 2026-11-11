import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FetchHandler, HttpHandler } from "../src/index.js";

const CANONICAL = "export type FetchHandler = (request: Request) => Response | Promise<Response>;";

// One handler type across webrun-wire. webrun-http-proxy and webrun-http-events keep zero runtime
// dependencies, so they declare it themselves (TypeScript types are structural). They are checked
// here by their source text: a dev dependency on them would close a build cycle
// (events -> browser -> streams).
describe("FetchHandler", () => {
  it("is sync or async, as a Service Worker's or a Durable Object's fetch", () => {
    expectTypeOf<FetchHandler>().toEqualTypeOf<
      (request: Request) => Response | Promise<Response>
    >();
    expectTypeOf<HttpHandler>().toEqualTypeOf<FetchHandler>();
  });

  it("webrun-http-proxy and webrun-http-events declare the same type", () => {
    for (const file of [
      "../../webrun-http-proxy/src/proxy.ts",
      "../../webrun-http-events/src/handler.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain(CANONICAL);
    }
  });
});
