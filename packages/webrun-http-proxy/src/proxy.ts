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
 * header, the credential-stripping rule, route headers applied last, and the body
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

/** Marks this layer's OWN responses, so they are never mistaken for an upstream's. Same header the proxy already uses. */
export const MARKER = "x-webrun-proxy";

/**
 * An upstream is just a handler. That is the whole merge: a local service, a
 * remote origin and another peer are all `(Request) => Promise<Response>`.
 */
export type Upstream = FetchHandler;

export interface UrlUpstreamInit {
  /**
   * Request headers to drop before re-issuing upstream, beyond the hop-by-hop
   * set this proxy always drops.
   *
   * For the surrounding system's own credential and anything it treats as
   * proven identity -- what a third-party origin has no business seeing.
   * `authorization` is forwarded unless it is named here.
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
    // WHATEVER THE CALLER'S SYSTEM TREATS AS ITS OWN CREDENTIAL OR IDENTITY
    // is consumed by this hop, the way `Proxy-Authorization` is consumed by the
    // proxy it names. This proxy knows nothing about the caller's trust model,
    // so the names are configuration: httpeers passes its membership-token and
    // proven-peer headers here, because re-issuing to a third party must hand
    // it neither a mesh token (an upstream once echoed one back) nor which
    // mesh peer called. Without this a caller would have to post-process the
    // request, by which point it has already gone.
    //
    // `authorization` is NOT on any built-in list. It belongs to the
    // application talking to the upstream -- a page calling an API with that
    // API's own key -- and dropping it made such a call impossible through the
    // proxy. A system that does put its credential there names it here.
    for (const name of init.stripRequestHeaders ?? []) headers.delete(name);
    // Hop-by-hop headers (RFC 9110 §7.6.1) are not the upstream's business.
    for (const hop of HOP_BY_HOP) headers.delete(hop);
    if (init.via != null) headers.set("via", init.via);
    // Operator configuration last, so it wins over anything a caller sent.
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    for (const [name, value] of Object.entries(init.credential?.() ?? {})) headers.set(name, value);

    // FIREFOX HAS NO `Request.prototype.body` (checked against 155):
    // `request.body` reads as `undefined` there even for a genuine payload, so
    // `body: request.body` silently builds a bodyless outbound request in that
    // engine while working in Chromium, where the property is a stream. This
    // defect has shipped from this exact pattern four times already
    // (statewalker/httpeers: edge-dispatch.ts, two sites in core/router.ts, a
    // demo page) — a POST through a session origin arrived as 0 bytes sent, in
    // Firefox only, everywhere else silent.
    //
    // The streaming path stays first and unconditional: a runtime that has
    // request streams never reaches the fallback, and never buffers an upload.
    let body: ReadableStream<Uint8Array> | ArrayBuffer | undefined;
    if (request.body != null) {
      body = request.body;
    } else {
      // `request.body` reads `null`/`undefined` for two different reasons that
      // are indistinguishable from here: genuinely no body (GET, HEAD, a POST
      // built with none), or Firefox's missing accessor hiding a real one.
      // Buffering the whole of it is the only way to tell them apart, and it
      // is cheap in the genuinely-empty case — `arrayBuffer()` on a bodyless
      // request resolves immediately with zero bytes, it does not wait on the
      // network. A zero-length result is indistinguishable from an absent body
      // (Chromium's own `new Request(url, { method: "POST", body: "" })`
      // yields a non-null *empty* stream, which the branch above already
      // handles), so an empty buffer here is treated as absent too.
      const buffered = await request.arrayBuffer();
      if (buffered.byteLength > 0) body = buffered;
    }

    const outbound = new Request(target, {
      method: request.method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
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
