import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import {
  type AuthPredicate,
  type EndpointEnv,
  type EndpointHandler,
  type ErrorHandler,
  type ServeFilesOptions,
  SiteBuilder,
  type SiteHandler,
} from "@statewalker/webrun-site-builder";
import { resolveFilesSource } from "./resolve-files.js";
import type { AdapterFactory, FilesSource, HostedSite, SiteAdapter } from "./types.js";

export interface HostedSiteBuilderOptions {
  /**
   * Override the `SiteAdapter` used behind the scenes. Defaults to
   * `new SwHttpAdapter({ key, serviceWorkerUrl })`. Useful for tests or
   * for plugging in a non-SW transport (e.g. a MessagePort bridge).
   */
  adapterFactory?: AdapterFactory;
}

interface FilesMount {
  prefix: string;
  source: FilesSource;
  options?: ServeFilesOptions;
}

interface EndpointDef {
  pattern: string;
  method: string | undefined;
  handler: EndpointHandler;
}

interface ServerRunner {
  pattern: string;
  modulePath: string;
  method: string | undefined;
  env: Record<string, unknown> | undefined;
}

interface AuthDef {
  pattern: string;
  predicate: AuthPredicate;
}

/**
 * High-level builder that wraps `SiteBuilder` + `SwHttpAdapter` into a
 * single fluent API. Registers a same-origin ServiceWorker, composes the
 * handler, rewrites URLs from SW form (`/<key>/...`) to site-local form
 * before dispatching, and returns a handle with `baseUrl` + `stop()`.
 *
 * Typical use:
 *
 * ```ts
 * const site = await new HostedSiteBuilder()
 *   .setSiteKey("demo")
 *   .setFiles("/client", clientFiles)
 *   .setFiles("/server", { "/api/index.js": "..." })
 *   .setServerRunner("/api", "/server/api/index.js")
 *   .build();
 *
 * iframe.src = `${site.baseUrl}client/`;
 * ```
 */
export class HostedSiteBuilder {
  #siteKey?: string;
  #swUrl?: string;
  readonly #filesMounts: FilesMount[] = [];
  readonly #endpoints: EndpointDef[] = [];
  readonly #serverRunners: ServerRunner[] = [];
  readonly #auths: AuthDef[] = [];
  #errorHandler?: ErrorHandler;
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
   * Mount a file tree under `prefix`. Accepts a `FilesApi` implementation
   * or a `{path → content}` record (wrapped in `MemFilesApi`).
   */
  setFiles(prefix: string, source: FilesSource, options?: ServeFilesOptions): this {
    this.#filesMounts.push({ prefix, source, options });
    return this;
  }

  /**
   * Register a dynamic endpoint (same semantics as `SiteBuilder.setEndpoint`).
   */
  setEndpoint(pattern: string, method: string, handler: EndpointHandler): this;
  setEndpoint(pattern: string, handler: EndpointHandler): this;
  setEndpoint(
    pattern: string,
    methodOrHandler: string | EndpointHandler,
    handler?: EndpointHandler,
  ): this {
    const [method, fn] =
      typeof methodOrHandler === "string"
        ? [methodOrHandler, handler as EndpointHandler]
        : [undefined, methodOrHandler];
    this.#endpoints.push({ pattern, method, handler: fn });
    return this;
  }

  /**
   * Shortcut that registers an endpoint whose handler dynamic-imports
   * `${baseUrl}${modulePath}` and delegates to its default export.
   *
   * The module is fetched through the same site handler (so a `/server`
   * files mount serves it as JS), then evaluated by the browser's native
   * module loader. Each invocation re-imports — the module cache lives in
   * the browser, so repeated imports of the same URL are cheap.
   *
   * `options` carries the environment values forwarded to the server
   * module: anything not named `method` becomes part of the `env` bag
   * the handler receives alongside `params` (DB connections, FilesApi
   * instances, secrets, …). `options.method` (if set) restricts the
   * endpoint to a single HTTP verb.
   */
  setServerRunner(
    pattern: string,
    modulePath: string,
    options: Record<string, unknown> & { method?: string } = {},
  ): this {
    const { method, ...env } = options;
    this.#serverRunners.push({ pattern, modulePath, method, env });
    return this;
  }

  /** Add an auth gate (same semantics as `SiteBuilder.setAuth`). */
  setAuth(pattern: string, predicate: AuthPredicate): this {
    this.#auths.push({ pattern, predicate });
    return this;
  }

  /** Override the default 500 error handler. */
  setErrorHandler(handler: ErrorHandler): this {
    this.#errorHandler = handler;
    return this;
  }

  /**
   * Activate the site:
   * 1. Generate the site key (if not set).
   * 2. Construct and start the adapter (registers the SW).
   * 3. Build the `SiteBuilder` handler from the collected config.
   * 4. Register it with the adapter, rewriting URLs to site-local form.
   *
   * Returns the `HostedSite` handle with `baseUrl` + `stop()`.
   */
  async build(): Promise<HostedSite> {
    const siteKey = this.#siteKey ?? crypto.randomUUID();
    const swUrl = this.#swUrl ?? defaultSwUrl();

    const adapter = this.#adapterFactory({ key: siteKey, serviceWorkerUrl: swUrl });
    await adapter.start();

    // `baseUrl` is only known after `register()` resolves, but the
    // server-runner endpoints need it to form the dynamic-import URL.
    // Close over a mutable reference and assign below.
    let baseUrl = "";
    const siteHandler = await this.#buildSiteHandler(() => baseUrl);

    const registration = await adapter.register(`${siteKey}/`, (request) =>
      siteHandler(rewriteToSiteRelative(request, () => baseUrl)),
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

  async #buildSiteHandler(getBaseUrl: () => string): Promise<SiteHandler> {
    const sb = new SiteBuilder();
    for (const { prefix, source, options } of this.#filesMounts) {
      const filesApi = await resolveFilesSource(source);
      sb.setFiles(prefix, filesApi, options);
    }
    for (const { pattern, method, handler } of this.#endpoints) {
      if (method !== undefined) sb.setEndpoint(pattern, method, handler);
      else sb.setEndpoint(pattern, handler);
    }
    for (const { pattern, modulePath, method, env } of this.#serverRunners) {
      const runner = newServerRunner(modulePath, getBaseUrl, env);
      if (method !== undefined) sb.setEndpoint(pattern, method, runner);
      else sb.setEndpoint(pattern, runner);
    }
    for (const { pattern, predicate } of this.#auths) sb.setAuth(pattern, predicate);
    if (this.#errorHandler) sb.setErrorHandler(this.#errorHandler);
    return sb.build();
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
 * passed through `options` with the per-request `params`. Errors
 * surface as `500` responses so the SW never crashes on a missing /
 * broken module.
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
      // dynamic specifier when bundling. (Pulling the URL into a variable
      // and importing the variable causes rolldown to inline it without
      // the comment, re-triggering the vite:import-analysis warning in
      // downstream consumers.)
      const mod = (await import(/* @vite-ignore */ `${getBaseUrl()}${trimmed}`)) as {
        default?: (request: Request, env: EndpointEnv) => Response | Promise<Response>;
      };
      if (typeof mod.default !== "function") {
        return new Response(`Module ${modulePath} has no default export`, { status: 500 });
      }
      // Merge order (least → most specific): SiteBuilder env (already in
      // `incoming`), runner-level env, per-request `params`. Runner-level
      // values win over site-level for this endpoint; `params` always wins.
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
    // Allow streaming bodies on non-GET/HEAD; required by recent Fetch specs.
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  return new Request(`http://site.local${normalized}`, init);
}
