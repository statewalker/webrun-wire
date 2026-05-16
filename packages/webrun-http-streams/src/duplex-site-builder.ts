import type { Serve } from "@statewalker/webrun-streams";
import { serveFetchOverDuplex } from "./fetch.js";

/**
 * Structural alias of `SiteHandler` from `@statewalker/webrun-site-builder`.
 * Kept local so this package doesn't depend on `webrun-site-builder`.
 */
export type SiteHandler = (request: Request) => Promise<Response>;

/**
 * Host a `SiteHandler` over a `Connect/Serve` pair. The `start(serve, params)`
 * call hands the handler to any `webrun-streams-*` adapter's `serve`.
 *
 * ```ts
 * import { SiteBuilder } from "@statewalker/webrun-site-builder";
 * import { DuplexSiteBuilder } from "@statewalker/webrun-http-streams";
 * import { serve } from "@statewalker/webrun-streams-port";
 *
 * const handler = new SiteBuilder()
 *   .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
 *   .build();
 *
 * const stop = await new DuplexSiteBuilder().setHandler(handler).start(serve, { port });
 * // later: await stop();
 * ```
 *
 * Holds no site-configuration state. Endpoints, files, auth belong to the
 * `SiteHandler` producer (typically `SiteBuilder`).
 */
export class DuplexSiteBuilder {
  #handler?: SiteHandler;

  setHandler(handler: SiteHandler): this {
    this.#handler = handler;
    return this;
  }

  async start<P>(serve: Serve<P>, params: P): Promise<() => Promise<void>> {
    if (!this.#handler) {
      throw new Error("DuplexSiteBuilder.start: setHandler(handler) must be called before start()");
    }
    const handler = this.#handler;
    return serve(
      params,
      serveFetchOverDuplex(async (req) => handler(req)),
    );
  }
}
