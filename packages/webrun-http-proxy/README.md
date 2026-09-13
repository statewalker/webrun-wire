# @statewalker/webrun-http-proxy

Re-issue an HTTP request to an outside origin, safely. **One function.**

**Zero runtime dependencies. One entry point.**

```ts
import { Hono } from "hono";
import { urlUpstream } from "@statewalker/webrun-http-proxy";

const openai = urlUpstream({
  base: "https://api.openai.com/v1",
  credential: () => ({ authorization: `Bearer ${apiKey()}` }),
});

const app = new Hono();
app.all("/openai/:rest{.*}", (c) => {
  const { pathname, search } = new URL(c.req.url);
  return openai(new Request(`http://upstream${pathname.slice("/openai".length)}${search}`, c.req.raw));
});
```

## Bring your own router

This package used to ship a route table as well — prefix matching, path
rewriting, a listing endpoint, a marker header on unmatched paths, a route
store. That turned out to be the uninteresting half: it is what a router does,
and every caller already has one.

The evidence is in `tests/scenarios.ts`. Twelve scenarios established this
proxy's behaviour in the prototype; they now run against **a plain Hono
router** and pass unchanged. Nothing was lost with the table, and the segment
matching got better — Hono matches on segment boundaries, so `/open` no longer
swallows `/openai`, which the hand-written table had to special-case.

Persisting route configuration went with the router, for the same reason: the
shape of that configuration belongs to whoever defines the routes. If you store
routes, store the credential's header **name** and never its **value** — the
value belongs in memory, merged per request through `credential`. (An earlier
shape of this API stored a whole route, and building a proxy page on it would
have written bearer keys into `localStorage`.)

## What `urlUpstream` actually does

None of this is obvious, and all of it was found by measurement:

- The caller's `authorization` is **consumed by this hop**, the way
  `Proxy-Authorization` is consumed by the proxy it names. Forwarding it handed
  a bearer token to an upstream that echoed it straight back.
- `stripRequestHeaders` drops whatever else the caller's system treats as
  proven identity. A third-party origin has no business seeing it.
- Hop-by-hop headers (RFC 9110 §7.6.1) are dropped.
- `credential` is read at **request** time, so a key can be typed while traffic
  flows.
- The body **streams** rather than buffering, and the caller's `signal` is
  forwarded, so an abandoned request abandons the upstream call.
- An **opaque redirect** is reported as a redirect. It has status `0`, and
  constructing a `Response` with status 0 throws *inside* the `try` — which
  reported a redirecting upstream as `502 upstream-unreachable`.

A **local** handler is just a `FetchHandler` you route to directly: do not put
it behind this. Calling a handler on this side of the proxy must **not** strip
`authorization`, because it still needs to know who is calling.

## One row a browser cannot pass

`Via` is a forbidden header name under the Fetch spec — a page may not set it,
and the browser drops it with no error. ADR-0015 has an intermediary announce
itself with `Via`, so that part is unimplementable in a browser-hosted
intermediary. A fact about the platform, not about this code.

## No platform

No transport, no crypto, no platform code at all — re-issuing a request needs
none of it, which is why a proxy **page** and a Node process use the same entry
point. `tests/boundary.test.ts` asserts there is no platform entry point left
to exempt, and the dependency list is **empty**.

## Where it came from

Extracted from `@statewalker/httpeers-expose`, where it was a mesh concept by
accident of where it was written. Nothing in it is about peers. The one place
the old package knew about meshes is now `stripRequestHeaders`: httpeers passes
its proven-peer header there.

**9 tests**, and the twelve scenarios run inside two of them — the suite
asserts that every scenario ran (guarding against an empty list) and that none
failed.
