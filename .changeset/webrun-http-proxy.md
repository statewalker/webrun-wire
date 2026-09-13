---
"@statewalker/webrun-http-proxy": minor
---

New package: re-issue an HTTP request to an outside origin, safely.

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
this proxy's behaviour now run against a plain Hono router and pass unchanged,
which is the evidence that removing it lost nothing — and the segment matching
got better, since a router matches on segment boundaries and `/open` no longer
swallows `/openai`. Persisting route configuration went with it, because the
shape of that configuration belongs to whoever defines the routes.

Extracted from `@statewalker/httpeers-expose`, where it was a mesh concept by
accident of where it was written. Nothing in it is about peers. The one place
the old package knew about meshes is now `stripRequestHeaders`, so any caller
can name whatever its own system treats as proven identity and keep it from
reaching a third-party origin.
