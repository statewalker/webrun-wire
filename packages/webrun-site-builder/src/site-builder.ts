import type { FilesApi } from "@statewalker/webrun-files";
import { newRouteMatcher, type RouteMatcher } from "./match-route.js";
import { newServeFiles, type ServeFilesOptions } from "./serve-files.js";

/**
 * A fetch-style request handler as accepted and returned by the builder.
 */
export type SiteHandler = (request: Request) => Promise<Response>;

/**
 * Shared environment passed to every endpoint handler. Carries
 * builder-level values (DB connections, secrets, FilesApi instances, …)
 * plus the `params` extracted from the URL pattern for this request.
 */
export type EndpointEnv = Record<string, unknown> & {
  params: Record<string, string>;
};

/**
 * An endpoint handler receives the original `Request` and an `env` bag
 * combining builder-level values (set via `setEnv`) with per-request
 * `params` extracted from the URL pattern.
 */
export type EndpointHandler = (request: Request, env: EndpointEnv) => Response | Promise<Response>;

/**
 * An auth predicate inspects the request and decides whether to let it
 * through. Returning a `Response` short-circuits the pipeline (typically
 * a `401` challenge); returning `undefined` passes the request to the next
 * layer.
 */
export type AuthPredicate = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Error handler called when any layer throws. Defaults to a plain `500`.
 */
export type ErrorHandler = (error: unknown, request: Request) => Response | Promise<Response>;

interface FilesRoute {
  prefix: string;
  serve: (request: Request, path: string) => Promise<Response>;
}

interface EndpointRoute {
  matcher: RouteMatcher;
  handler: EndpointHandler;
}

interface AuthRoute {
  matcher: RouteMatcher;
  predicate: AuthPredicate;
}

/**
 * Compose a site from static files, dynamic endpoints, and auth hooks. The
 * builder is fluent — each setter returns the same instance — and
 * `build()` produces a single fetch-style handler that runs every layer
 * in order.
 *
 * Dispatch order on each request:
 *
 * 1. **Auth** — every predicate whose pattern matches runs in registration
 *    order; the first one that returns a `Response` wins.
 * 2. **Endpoints** — first registered pattern + method match wins.
 * 3. **Files** — first registered prefix that is a real prefix of the URL
 *    path wins; a path resolving to a directory falls back to `index.html`.
 * 4. **404** — nothing matched.
 *
 * Any uncaught throw from any layer is routed to the error handler.
 */
export class SiteBuilder {
  #files: FilesRoute[] = [];
  #endpoints: EndpointRoute[] = [];
  #auths: AuthRoute[] = [];
  #env: Record<string, unknown> = {};
  #errorHandler: ErrorHandler = defaultErrorHandler;

  /**
   * Mount a `FilesApi` under `prefix`. Multiple file roots can be mounted
   * side-by-side — `.setFiles("/client", a).setFiles("/server", b)` —
   * and the first matching prefix wins.
   */
  setFiles(prefix: string, filesApi: FilesApi, options?: ServeFilesOptions): this {
    this.#files.push({
      prefix: normalizePrefix(prefix),
      serve: newServeFiles(filesApi, options),
    });
    return this;
  }

  /**
   * Register a dynamic endpoint. `method` can be a concrete verb
   * (`"GET"`, `"POST"`, …) or `"*"` / `"ALL"` to match any method. The
   * three-argument overload matches an explicit method; the two-argument
   * form defaults to `"*"`.
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
        : ["*", methodOrHandler];
    this.#endpoints.push({
      matcher: newRouteMatcher(pattern, method),
      handler: fn,
    });
    return this;
  }

  /**
   * Guard routes matching `pattern` with `predicate`. The predicate is
   * invoked for every matching request; returning a `Response`
   * short-circuits (typical for a `401` challenge), returning
   * `undefined` lets the request through. See `newBasicAuth` for a
   * ready-made HTTP-basic predicate.
   */
  setAuth(pattern: string, predicate: AuthPredicate): this {
    this.#auths.push({
      matcher: newRouteMatcher(pattern, "*"),
      predicate,
    });
    return this;
  }

  /**
   * Override the default error handler. Called with `(error, request)`
   * whenever any layer throws. Must return a `Response`.
   */
  setErrorHandler(handler: ErrorHandler): this {
    this.#errorHandler = handler;
    return this;
  }

  /**
   * Merge `values` into the shared environment passed to every endpoint
   * handler. Callers receive the bag as `env` along with the per-request
   * `params`, so handlers can read DB connections, FilesApi instances,
   * secrets, etc. without closing over module-level state. Successive
   * calls merge — later keys win.
   */
  setEnv(values: Record<string, unknown>): this {
    this.#env = { ...this.#env, ...values };
    return this;
  }

  /**
   * Produce the composed `(Request) ⇒ Response` handler.
   */
  build(): SiteHandler {
    const auths = [...this.#auths];
    const endpoints = [...this.#endpoints];
    const files = [...this.#files];
    const env = { ...this.#env };
    const errorHandler = this.#errorHandler;

    return async (request: Request): Promise<Response> => {
      try {
        // Auth gate.
        for (const { matcher, predicate } of auths) {
          if (matcher.match(request)) {
            const blocked = await predicate(request);
            if (blocked) return blocked;
          }
        }

        // Endpoints first (explicit routes beat static paths).
        for (const { matcher, handler } of endpoints) {
          const params = matcher.match(request);
          if (params) return await handler(request, { ...env, params });
        }

        // Static files.
        const url = new URL(request.url);
        for (const { prefix, serve } of files) {
          if (matchesPrefix(url.pathname, prefix)) {
            const subPath = stripPrefix(url.pathname, prefix);
            return await serve(request, subPath);
          }
        }

        return new Response("Not Found", { status: 404 });
      } catch (error) {
        return errorHandler(error, request);
      }
    };
  }
}

function defaultErrorHandler(_error: unknown, _request: Request): Response {
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Normalize a prefix: strip trailing slash, ensure leading slash. Empty
 * stays empty (means "mount at the root").
 */
function normalizePrefix(prefix: string): string {
  let p = prefix.trim();
  if (p === "" || p === "/") return "";
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "") return true;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
}

function stripPrefix(pathname: string, prefix: string): string {
  if (prefix === "") return pathname;
  const rest = pathname.substring(prefix.length);
  return rest === "" ? "/" : rest;
}
