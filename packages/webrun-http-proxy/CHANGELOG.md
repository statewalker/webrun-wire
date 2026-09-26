# @statewalker/webrun-http-proxy

## 0.2.1

### Patch Changes

- 3708e93: Fix: `urlUpstream` sent no body at all in Firefox. Firefox (checked against 155) has no `Request.prototype.body` — the property reads `undefined` there
  even for a genuine payload — so rebuilding the outbound request with `body:
request.body` silently dropped every POST/PUT/PATCH body in that engine while
  working in Chromium, where the property is a stream. A POST through a session
  origin arrived as `0 bytes of 76 sent`, Firefox only, nothing else in the
  response indicating loss.

  This is the fifth site of the same defect; four were already fixed in
  `statewalker/httpeers` (`edge-dispatch.ts`, two in `core/router.ts`, a demo
  page).

  The fix buffers via `arrayBuffer()` only when `request.body` reads absent — a
  real stream still streams, so a large upload through a runtime that supports
  request streams is never held in memory. `duplex: "half"` is now set only when
  the outbound body is actually a `ReadableStream`.

  A request whose body was already read elsewhere now resolves to this
  package's own `502 upstream-unreachable`, the same as any other unreachable
  upstream, instead of throwing out of the handler.

## 0.2.0

### Minor Changes

- The package is `urlUpstream` (with `MARKER` and its types) and nothing else. The route table that 0.1.0 shipped (prefix matching, the listing, the marker on unmatched paths, the route store and the `node`/`browser` entry points) is removed: every caller already has a router, and the twelve scenarios that established the proxy's behaviour pass unchanged against a plain Hono router. Breaking for a caller that used the route table: mount `urlUpstream` in your own router.
- c7dc018: `urlUpstream` no longer drops `authorization`. That header belongs to the application calling the upstream, and dropping it made calling an API with its own key through the proxy impossible. A system that keeps its own credential in a request header names that header in `stripRequestHeaders`, which is consumed at this hop as before. Breaking for a caller that relied on the implicit drop: add `"authorization"` to `stripRequestHeaders` to keep the old behaviour.

## 0.1.0

### Minor Changes

- 924f01a: New package: re-issue an HTTP request to an outside origin, safely.

  **One function, one entry point, zero runtime dependencies.** `urlUpstream`
  consumes the caller's `authorization` at this hop rather than forwarding it,
  drops whatever else the caller names as proven identity
  (`stripRequestHeaders`), drops the hop-by-hop set, reads the credential at
  request time so a key can be typed while traffic flows, streams the body, and
  forwards the caller's `signal`. Two defects it had already fixed come with it —
  a redirecting upstream reported as `502 upstream-unreachable` (an opaque
  redirect has status `0`, and constructing a `Response` with it throws inside
  the `try`), and an outbound request that carried no `signal`.

  **Routing is the caller's.** An earlier shape of this package also shipped a
  route table, a listing endpoint and a route store. That half is what a router
  does, and every caller already has one: the twelve scenarios that established
  this proxy's behaviour run against a plain Hono router and pass unchanged,
  which is the evidence that removing it lost nothing — and the matching got
  better, since a router matches on segment boundaries and `/open` no longer
  swallows `/openai`. Persisting route configuration went with it, because the
  shape of that configuration belongs to whoever defines the routes.

  Extracted from `@statewalker/httpeers-expose`, where it was a mesh concept by
  accident of where it was written. Nothing in it is about peers. The one place
  the old package knew about meshes is now `stripRequestHeaders`, so any caller
  can name whatever its own system treats as proven identity and keep it from
  reaching a third-party origin.
