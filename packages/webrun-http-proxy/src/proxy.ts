/**
 * The candidate `expose` package: ONE route table, two kinds of upstream.
 *
 * THE CLAIM THIS TESTS. "Reverse proxy" and "expose a local service" are the
 * same mechanism — match a prefix, rewrite the path, stream the result — and
 * differ only in the last step: an in-process handler is CALLED, a URL
 * upstream is RE-ISSUED. If that is true, `routeTable` below serves both and
 * the two features are one package.
 *
 * Everything except the upstream kind is lifted from `services/proxy.ts` and
 * `services/proxy-routes.ts`, which already run in the mesh: longest-prefix
 * matching on segment boundaries, the listing at the mount root, the marker
 * header, the `authorization` rule, route headers applied last, and the body
 * handed on unread.
 *
 * TWO DEFECTS OF THE PROVEN CODE ARE FIXED HERE, both measured in the tests:
 *
 *   1. `redirect: "manual"` makes a browser return an opaque response whose
 *      status is 0, and `new Response(body, { status: 0 })` THROWS — inside
 *      the try, so a redirecting upstream is reported as
 *      `502 upstream-unreachable`. `urlUpstream` handles redirects explicitly.
 *   2. The outbound request carried no `signal`, so an aborted caller left the
 *      upstream call running. It is forwarded.
 */

/**
 * A handler, in the only shape this package needs.
 *
 * Declared here rather than imported: it is one line, and depending on another
 * package for it would give a proxy a dependency it has no other use for.
 */
export type FetchHandler = (request: Request) => Promise<Response>;
import { matchRoute } from "./routes.js";

/** Marks this layer's OWN responses, so they are never mistaken for an upstream's. Same header the proxy already uses. */
export const MARKER = "x-webrun-proxy";

/**
 * An upstream is just a handler. That is the whole merge: a local service, a
 * remote origin and another peer are all `(Request) => Promise<Response>`.
 */
export type Upstream = FetchHandler;

export interface Route {
  /** Path prefix, matched on segment boundaries, longest first. */
  prefix: string;
  /** What this route reaches, for the listing at the mount root. Never a credential. */
  describe: string;
  upstream: Upstream;
}

export interface RouteTableInit {
  /** Read per request, never snapshotted, so routes can be edited live. */
  routes: () => readonly Route[];
  /** Where this table is mounted; stripped before matching. */
  mountPrefix?: string;
}

/**
 * The mount: match, strip, delegate. Identical on both platforms — it touches
 * no DOM, no `node:` module and no network of its own.
 */
export function routeTable(init: RouteTableInit): FetchHandler {
  const mountPrefix = init.mountPrefix ?? "/proxy";

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith(mountPrefix)
      ? url.pathname.slice(mountPrefix.length)
      : url.pathname;

    // The listing: prefixes and descriptions, never headers — a header value
    // is a credential and every member of the mesh can read this.
    if ((pathname === "" || pathname === "/") && request.method === "GET") {
      const body = JSON.stringify({
        routes: init.routes().map((r) => ({ prefix: r.prefix, upstream: r.describe })),
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }

    // `matchRoute` is the PROVEN matcher, imported rather than copied: it is
    // what enforces segment boundaries, so `/files` does not swallow
    // `/filesystem`. It expects `{prefix, upstream, headers}`-shaped records,
    // so the route is presented to it with `upstream` as its description.
    const shaped = init.routes().map((r) => ({
      prefix: r.prefix,
      upstream: r.describe,
      headers: {},
    }));
    const found = matchRoute(shaped, pathname);
    if (found == null) {
      return new Response(`no route for ${pathname}`, {
        status: 404,
        headers: { [MARKER]: "no-route" },
      });
    }

    const route = init.routes().find((r) => r.prefix === found.route.prefix);
    if (route == null) {
      return new Response(`no route for ${pathname}`, {
        status: 404,
        headers: { [MARKER]: "no-route" },
      });
    }

    // The rest of the path, plus the query, as a request the upstream sees.
    // The URL's origin is carried over so a handler upstream still gets a
    // well-formed absolute URL; a `urlUpstream` replaces it entirely.
    const rewritten = new URL(`${found.rest || "/"}${url.search}`, url.origin);
    const forwarded = new Request(rewritten, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(request.body != null ? { duplex: "half" as const } : {}),
      signal: request.signal,
    });

    return route.upstream(forwarded);
  };
}

export interface UrlUpstreamInit {
  /**
   * Request headers to drop before re-issuing upstream, beyond the ones this
   * proxy always drops (`authorization` and the hop-by-hop set).
   *
   * For anything the surrounding system treats as proven identity and that a
   * third-party origin has no business seeing.
   */
  stripRequestHeaders?: readonly string[];

  /** Origin (and optional base path) every request is re-issued against. */
  base: string;
  /** Static headers for this destination, applied after the caller's. */
  headers?: Record<string, string>;
  /** A credential for this destination, read per request so it need not be held in the route. */
  credential?: () => Record<string, string> | undefined;
  /** Injected by tests; defaults to the platform's. */
  fetchImpl?: typeof fetch;
  /** `Via` value; omitted, no `Via` is added. */
  via?: string;
}

/**
 * Re-issue the request to a URL — the "reverse proxy" half.
 *
 * THE HYGIENE IS HERE AND NOT IN THE TABLE, because it applies only when a
 * request LEAVES the mesh. Calling a local handler must not strip the caller's
 * identity; re-issuing to a third party must.
 */
export function urlUpstream(init: UrlUpstreamInit): Upstream {
  const doFetch = init.fetchImpl ?? globalThis.fetch;

  return async (request: Request): Promise<Response> => {
    const from = new URL(request.url);
    const target = new URL(`.${from.pathname}${from.search}`, ensureSlash(init.base));

    const headers = new Headers(request.headers);
    // The mesh's own credential is consumed by this hop, the way
    // `Proxy-Authorization` is consumed by the proxy it names. Forwarding it
    // handed mesh tokens to third parties (an upstream echoed one back) and
    // turned every call into a preflighted one.
    headers.delete("authorization");
    // WHATEVER ELSE THE CALLER'S SYSTEM TREATS AS IDENTITY. This proxy knows
    // nothing about the caller's trust model, so the names are configuration:
    // httpeers passes its proven-peer header here, because re-issuing to a
    // third party must not tell an outside origin which mesh peer called.
    // Without this a caller would have to post-process the request, by which
    // point it has already gone.
    for (const name of init.stripRequestHeaders ?? []) headers.delete(name);
    // Hop-by-hop headers (RFC 9110 §7.6.1) are not the upstream's business.
    for (const hop of HOP_BY_HOP) headers.delete(hop);
    if (init.via != null) headers.set("via", init.via);
    // Operator configuration last, so it wins over anything a caller sent.
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    for (const [name, value] of Object.entries(init.credential?.() ?? {})) headers.set(name, value);

    const outbound = new Request(target, {
      method: request.method,
      headers,
      body: request.body,
      ...(request.body != null ? { duplex: "half" as const } : {}),
      signal: request.signal,
      redirect: "manual",
    });

    try {
      const upstream = await doFetch(outbound);
      // AN OPAQUE REDIRECT HAS STATUS 0, and `new Response(body, {status: 0})`
      // throws — which is how the shipping proxy reports a redirecting
      // upstream as `502 upstream-unreachable`. Reported as what it is.
      if (upstream.type === "opaqueredirect" || upstream.status === 0) {
        return new Response("upstream redirected; the proxy does not follow redirects", {
          status: 502,
          headers: { [MARKER]: "upstream-redirect" },
        });
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        `upstream ${init.base} could not be reached: ${message}\n` +
          "If the upstream is up, it most likely does not permit cross-origin requests.",
        { status: 502, headers: { [MARKER]: "upstream-unreachable" } },
      );
    }
  };
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function ensureSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}
