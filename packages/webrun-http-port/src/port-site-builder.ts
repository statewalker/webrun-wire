import { serveFetchOverPort } from "./fetch/index.js";

/**
 * Structural alias of `SiteHandler` from `@statewalker/webrun-site-builder`.
 * Kept local so this package doesn't depend on `webrun-site-builder`; the
 * two types are deliberately compatible.
 */
export type SiteHandler = (request: Request) => Promise<Response>;

/**
 * Host a `SiteHandler` on a `MessagePort` via `serveFetchOverPort`. The
 * cross-platform sibling of `HostedSiteBuilder` (browser+SW) — same
 * `SiteHandler` seam, different transport.
 *
 * ```ts
 * import { SiteBuilder } from "@statewalker/webrun-site-builder";
 * import { PortSiteBuilder } from "@statewalker/webrun-http-port";
 *
 * const handler = new SiteBuilder()
 *   .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
 *   .build();
 *
 * const stop = new PortSiteBuilder(port).setHandler(handler).start();
 * // later: stop();
 * ```
 *
 * Holds no site-configuration state. Endpoints, files, auth belong to the
 * `SiteHandler` producer (typically `SiteBuilder`).
 */
export class PortSiteBuilder {
  readonly #port: MessagePort;
  #handler?: SiteHandler;

  constructor(port: MessagePort) {
    this.#port = port;
  }

  /** Install the site handler. Required before `start()`. */
  setHandler(handler: SiteHandler): this {
    this.#handler = handler;
    return this;
  }

  /**
   * Begin dispatching HTTP calls arriving on the port to the handler.
   * Returns an unsubscribe function — call it to detach.
   *
   * Throws if `setHandler` was not called.
   */
  start(): () => void {
    if (!this.#handler) {
      throw new Error("PortSiteBuilder.start: setHandler(handler) must be called before start()");
    }
    const handler = this.#handler;
    return serveFetchOverPort(this.#port, async (request) => handler(request));
  }
}
