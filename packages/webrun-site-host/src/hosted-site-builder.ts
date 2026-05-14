import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import type { EndpointEnv, EndpointHandler, SiteHandler } from "@statewalker/webrun-site-builder";
import type { AdapterFactory, HostedSite, SiteAdapter } from "./types.js";

export interface HostedSiteBuilderOptions {
  /**
   * Override the `SiteAdapter` used behind the scenes. Defaults to
   * `new SwHttpAdapter({ key, serviceWorkerUrl })`. Useful for tests or
   * for plugging in a non-SW transport.
   */
  adapterFactory?: AdapterFactory;
}

/**
 * Browser-side host for a {@link SiteHandler}. Registers a same-origin
 * ServiceWorker that intercepts fetch under `<origin>/<siteKey>/...`,
 * rewrites incoming requests to site-relative form (`/<path>`), and
 * dispatches to the supplied handler.
 *
 * `HostedSiteBuilder` owns *where* a site runs (browser + SW). It owns
 * nothing about *what* the site does — endpoints, files, auth, routing
 * belong to whatever produces the `SiteHandler` (typically `SiteBuilder`).
 *
 * Typical use:
 *
 * ```ts
 * const handler: SiteHandler = new SiteBuilder()
 *   .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
 *   .setFiles("/", clientFiles)
 *   .build();
 *
 * const site = await new HostedSiteBuilder()
 *   .setSiteKey("demo")
 *   .setHandler(handler)
 *   .build();
 *
 * iframe.src = site.baseUrl;
 * ```
 */
export class HostedSiteBuilder {
  #siteKey?: string;
  #swUrl?: string;
  #handler?: SiteHandler;
  readonly #adapterFactory: AdapterFactory;

  constructor({ adapterFactory = defaultAdapterFactory }: HostedSiteBuilderOptions = {}) {
    this.#adapterFactory = adapterFactory;
  }

  /**
   * Service key (first URL segment after the SW scope). Two sites on the
   * same origin must use distinct keys. Defaults to `crypto.randomUUID()`.
   */
  setSiteKey(key: string): this {
    this.#siteKey = key;
    return this;
  }

  /**
   * URL of the ServiceWorker script. Defaults to `/sw-worker.js` on the
   * current origin; only the default adapter factory consumes this.
   */
  setServiceWorkerUrl(url: string): this {
    this.#swUrl = url;
    return this;
  }

  /**
   * Install the site handler. Required before `build()`. The handler is a
   * `(Request) => Promise<Response>` produced by `SiteBuilder` or any other
   * source — including a forwarder that delegates to a remote peer via
   * `fetchOverPort`.
   */
  setHandler(handler: SiteHandler): this {
    this.#handler = handler;
    return this;
  }

  /**
   * Activate the site:
   * 1. Generate the site key (if not set).
   * 2. Construct and start the adapter (registers the SW).
   * 3. Register the handler with the adapter, rewriting URLs to site-local form.
   *
   * Returns the `HostedSite` handle with `baseUrl` + `stop()`.
   *
   * Throws if `setHandler` was not called.
   */
  async build(): Promise<HostedSite> {
    if (!this.#handler) {
      throw new Error("HostedSiteBuilder.build: setHandler(handler) must be called before build()");
    }
    const handler = this.#handler;
    const siteKey = this.#siteKey ?? crypto.randomUUID();
    const swUrl = this.#swUrl ?? defaultSwUrl();

    const adapter = this.#adapterFactory({ key: siteKey, serviceWorkerUrl: swUrl });
    await adapter.start();

    let baseUrl = "";
    const registration = await adapter.register(`${siteKey}/`, (request) =>
      handler(rewriteToSiteRelative(request, () => baseUrl)),
    );
    baseUrl = registration.baseUrl;

    return {
      siteKey,
      baseUrl,
      stop: async () => {
        // Detach the handler first so any in-flight request can still see
        // the adapter's bookkeeping, then tear down the adapter itself.
        await registration.remove();
        await adapter.stop?.();
      },
    };
  }
}

function defaultAdapterFactory({
  key,
  serviceWorkerUrl,
}: {
  key: string;
  serviceWorkerUrl: string;
}): SiteAdapter {
  return new SwHttpAdapter({ key, serviceWorkerUrl });
}

function defaultSwUrl(): string {
  if (typeof globalThis.location === "undefined") return "/sw-worker.js";
  return new URL("/sw-worker.js", globalThis.location.href).toString();
}

/**
 * Build a handler that dynamic-imports `${baseUrl}${modulePath}` and
 * delegates to its default export. The default export receives the
 * original `Request` plus an `env` bag merging the runner-level values
 * with the per-request `params`. Errors surface as `500` responses so the
 * SW never crashes on a missing / broken module.
 *
 * Standalone utility — composes with `SiteBuilder.setEndpoint` so callers
 * can opt into the "endpoint as a dynamically-imported module" pattern
 * without `HostedSiteBuilder` knowing about it:
 *
 * ```ts
 * let getBaseUrl = () => "";
 * const handler = new SiteBuilder()
 *   .setEndpoint("/api", newServerRunner("/server/api/index.js", () => getBaseUrl()))
 *   .build();
 * const site = await new HostedSiteBuilder().setHandler(handler).build();
 * getBaseUrl = () => site.baseUrl;
 * ```
 */
export function newServerRunner(
  modulePath: string,
  getBaseUrl: () => string,
  env?: Record<string, unknown>,
): EndpointHandler {
  const trimmed = modulePath.startsWith("/") ? modulePath.slice(1) : modulePath;
  const runnerEnv = env ?? {};
  return async (request, incoming) => {
    try {
      // Inline template literal — keep `/* @vite-ignore */` directly inside
      // `import(...)` so rolldown does not separate the comment from the
      // dynamic specifier when bundling.
      const mod = (await import(/* @vite-ignore */ `${getBaseUrl()}${trimmed}`)) as {
        default?: (request: Request, env: EndpointEnv) => Response | Promise<Response>;
      };
      if (typeof mod.default !== "function") {
        return new Response(`Module ${modulePath} has no default export`, { status: 500 });
      }
      const merged: EndpointEnv = { ...incoming, ...runnerEnv, params: incoming.params };
      return await mod.default(request, merged);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(message, { status: 500 });
    }
  };
}

/**
 * Strip the site's base URL from the request (the `/<key>/...` prefix
 * the SW layer uses for routing) so the inner `SiteHandler` sees plain
 * site-relative paths like `/client/...` or `/api`.
 */
function rewriteToSiteRelative(request: Request, getBaseUrl: () => string): Request {
  const baseUrl = getBaseUrl();
  const relative =
    baseUrl && request.url.startsWith(baseUrl)
      ? request.url.substring(baseUrl.length) || "/"
      : new URL(request.url).pathname;
  const normalized = relative.startsWith("/") ? relative : `/${relative}`;
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  return new Request(`http://site.local${normalized}`, init);
}
