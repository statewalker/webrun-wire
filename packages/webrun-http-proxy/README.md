# @statewalker/webrun-http-proxy

## What it is

One function, `urlUpstream`, that turns a base URL into a
`(Request) => Promise<Response>` handler. The handler re-issues each incoming
request to that outside origin: it drops the headers that must not leave this
hop, adds the destination's own headers and credential, streams the body, and
reports failures as `502` responses instead of exceptions.

## Why it exists

Forwarding a request to a third-party origin looks like one line,
`fetch(new Request(target, request))`, and is wrong in several quiet ways. The
caller's own credential leaks to the upstream, and so do the proxy origin's
cookies. Hop-by-hop headers go along. In Firefox the body is silently dropped.
An upstream redirect throws inside the `try` and is reported as unreachable,
or, outside a browser, hands the caller the upstream's real address. Outside a
browser the body comes back decoded under the upstream's `content-encoding`.
An abandoned caller leaves the upstream call running. `urlUpstream` handles
each of these, and a browser page and a Node process use the same code.

Routing is not part of it. Prefix matching and path rewriting are what any
router (Hono, a `URLPattern` table, a `switch`) already does, so the package
takes a request that is already addressed and leaves routing to the caller.

## How to use

```sh
pnpm add @statewalker/webrun-http-proxy
```

- **Peer dependencies:** none. **Runtime dependencies:** none.
- **Entry point:** one, `.`. ESM only: `dist/index.js` with `dist/index.d.ts`.
  The `source` export condition points at `src/index.ts`.
- **Environment:** any runtime with `fetch`, `Request`, `Response` and
  `Headers`: Node, browsers, workers, Deno, Bun. No DOM API and no `node:`
  import; `tests/boundary.test.ts` enforces that.

| Export | What it is |
| --- | --- |
| `urlUpstream(init)` | Returns an `Upstream` that re-issues requests against `init.base`. |
| `UrlUpstreamInit` | Its options (below). |
| `Upstream`, `FetchHandler` | Both `(request: Request) => Response \| Promise<Response>`: the same type as `FetchHandler` in `@statewalker/webrun-http-streams`, declared here to keep zero dependencies. |
| `MARKER` | `"x-webrun-proxy"`, the header on responses this package makes itself. |

| `UrlUpstreamInit` field | Default | Meaning |
| --- | --- | --- |
| `base` | required | Origin and optional base path. The request's path and query are appended to it. |
| `stripRequestHeaders` | `[]` | Request headers to drop before re-issuing, beyond the hop-by-hop set. |
| `headers` | none | Static headers for this destination, set after the caller's. |
| `credential` | none | `() => Record<string, string> \| undefined`, read on every request and set last. |
| `via` | none | `Via` header value; omitted, no `Via` is added. |
| `forwardCookies` | `false` | `true` forwards the caller's `cookie` header and returns the upstream's `set-cookie`. Off, both are dropped. |

> **Changed in 0.4.0:** cookies are no longer forwarded by default. Up to
> 0.3.x the caller's `cookie` went to the upstream and the upstream's
> `set-cookie` came back. Pass `forwardCookies: true` to keep that behaviour.
> Also since 0.4.0, a real `3xx` redirect in Node or Deno answers
> `502 upstream-redirect` instead of being passed on.
| `fetchImpl` | `globalThis.fetch` | Injected `fetch`, for tests. |

## Examples

### Behind a Hono route

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

Only the path and query of the incoming URL are used, so the host in
`http://upstream…` is irrelevant. `POST /openai/chat/completions?x=1` is
re-issued as `POST https://api.openai.com/v1/chat/completions?x=1` with the
body streamed and `authorization` set from `credential`.

### Keeping your own credential off the upstream

```ts
import { urlUpstream } from "@statewalker/webrun-http-proxy";

const upstream = urlUpstream({
  base: "https://example.org/api",
  stripRequestHeaders: ["x-mesh-token", "x-proven-peer"],
});
```

## Internals

### What the proxy does to a request

```
incoming Request
  ├─ delete stripRequestHeaders            (caller's own identity)
  ├─ delete hop-by-hop headers             (RFC 9110 §7.6.1, and those `Connection` names)
  ├─ delete cookie                          (unless forwardCookies)
  ├─ narrow accept-encoding                 (to codings fetch decodes)
  ├─ set via                                (if configured)
  ├─ set headers                            (operator configuration)
  ├─ set credential()                       (read now, wins over everything)
  ├─ any of the above throws -> 502, x-webrun-proxy: upstream-unreachable
  ├─ body: stream, or buffer on Firefox     (never for GET/HEAD)
  └─ fetch(base + path + query, { signal, redirect: "manual" })
        ├─ opaque redirect or 301/302/303/307/308
        │                   -> 502, x-webrun-proxy: upstream-redirect
        ├─ throws           -> 502, x-webrun-proxy: upstream-unreachable
        └─ otherwise        -> upstream status and streamed body; headers minus
                               hop-by-hop, set-cookie (unless forwardCookies),
                               and content-encoding/content-length once decoded
```

### Your credential is consumed by this hop

Whatever `stripRequestHeaders` names is removed before the request leaves, the
way `Proxy-Authorization` is consumed by the proxy it names. That is where a
system puts its own credential and anything it treats as proven identity: a
third-party origin has no business seeing them, and an upstream that echoes
headers back would hand them to whoever reads the response.

`authorization` is not on any built-in list. It usually belongs to the
application talking to the upstream (a page calling an API with that API's
key), and dropping it would make that call impossible through the proxy. A
system that keeps its own credential in `authorization` names it in
`stripRequestHeaders`. `credential` still overrides whatever the caller sent.

Hop-by-hop headers are always dropped, from the request and from the
response: `connection`, `keep-alive`, `proxy-authenticate`,
`proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, and
every header the `Connection` header names (RFC 9110 §7.6.1).

Cookies are dropped by default: the caller's `cookie` is not sent upstream,
and the upstream's `set-cookie` is not returned. Behind a router on the proxy's
own origin, `cookie` carries that origin's session, which a third-party
upstream has no business seeing, and a returned `set-cookie` would let the
upstream plant cookies on the proxy's origin. `forwardCookies: true` passes
both. In a browser neither header can cross `fetch` anyway (both are forbidden
names), so the option only matters outside one.

`credential` is called per request, so a key can be entered or rotated while
traffic flows, and it is never stored in the proxy's configuration. If you
persist proxy routes, store the credential header's name, never its value.

### The body streams, except where the platform cannot

`GET` and `HEAD` never carry a body; the Fetch spec forbids one. Otherwise, if
`request.body` is a stream it is passed on with `duplex: "half"`, so a large
upload is never held in memory. Firefox (checked against 155) has no
`Request.prototype.body`; there `request.body` reads `undefined` even for a real
payload, and passing it on would send nothing. The proxy then buffers with
`request.arrayBuffer()`. An empty buffer is treated as no body. `duplex` is set
from the branch taken, not from `body instanceof ReadableStream`, because a
stream from another realm fails that check and `new Request` would then throw
`duplex option is required`.

The caller's `signal` is forwarded, so an abandoned request abandons the
upstream call.

The response body streams back as `fetch` hands it over. `fetch` has already
decoded a `gzip`, `deflate` or `br` body, so the proxy drops the upstream's
`content-encoding` and `content-length`, which describe the encoded bytes; a
client served through a Node adapter would otherwise wait for missing bytes or
try to gunzip plain text. Any other coding, `zstd` included (Node 22's `fetch`
does not decode it), is left as it is, with its raw body and its headers.

So that the upstream is not invited to send such a coding, the caller's
`accept-encoding` is narrowed to `gzip`, `x-gzip`, `deflate`, `br` and
`identity` (a caller sending only `zstd` gets `identity`). In a browser the
header is forbidden and the browser sets its own, so this only matters outside
one.

### Failures are responses, not exceptions

| Situation | Response |
| --- | --- |
| Upstream answers with a redirect (`301`, `302`, `303`, `307`, `308`) | `502`, `x-webrun-proxy: upstream-redirect`, body `upstream redirected; the proxy does not follow redirects` |
| Invalid `base`, a `headers` or `credential()` value that is not a valid header value, or a `credential()` that throws | `502`, `x-webrun-proxy: upstream-unreachable`, body `upstream <base> could not be reached: the outbound request could not be built …`. The underlying message is not included: it may quote the credential. |
| Network error, CORS refusal, body already read, any other throw | `502`, `x-webrun-proxy: upstream-unreachable`, body `upstream <base> could not be reached: <message>` and a line suggesting the upstream may not permit cross-origin requests |

Redirects are not followed (`redirect: "manual"`), and every platform gives
the same answer. In a browser that yields an opaque redirect with status `0`,
and `new Response(body, { status: 0 })` throws, which would otherwise surface
as `upstream-unreachable`. In Node and Deno it yields the real `3xx` with the
upstream's absolute `Location`, which would expose the upstream and send the
caller around the proxy and its credential. Both are reported as
`upstream-redirect`. `304 Not Modified` and the other `3xx` statuses that are
not redirects pass through.

The `x-webrun-proxy` header marks responses the proxy made itself, so they are
never mistaken for the upstream's.

### `Via` does not work in a browser

`Via` is a forbidden request header under the Fetch spec. A page may not set
it, and the browser drops it without an error. The `via` option therefore only
takes effect outside a browser.

### Dependencies

Zero runtime dependencies. `hono` is a dev dependency: `tests/scenarios.ts`
runs its scenarios through a plain Hono router to show the proxy needs no
router of its own.

### Scripts

```sh
pnpm test             # vitest run
pnpm run build        # rolldown + tsc --emitDeclarationOnly
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome check src tests
```

## License

MIT
