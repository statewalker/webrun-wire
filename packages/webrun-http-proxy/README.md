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
caller's own credential leaks to the upstream. Hop-by-hop headers go along. In
Firefox the body is silently dropped. An upstream redirect throws inside the
`try` and is reported as unreachable. An abandoned caller leaves the upstream
call running. `urlUpstream` handles each of these, and a browser page and a
Node process use the same code.

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
| `Upstream`, `FetchHandler` | Both `(request: Request) => Promise<Response>`. |
| `MARKER` | `"x-webrun-proxy"`, the header on responses this package makes itself. |

| `UrlUpstreamInit` field | Default | Meaning |
| --- | --- | --- |
| `base` | required | Origin and optional base path. The request's path and query are appended to it. |
| `stripRequestHeaders` | `[]` | Request headers to drop before re-issuing, beyond the hop-by-hop set. |
| `headers` | none | Static headers for this destination, set after the caller's. |
| `credential` | none | `() => Record<string, string> \| undefined`, read on every request and set last. |
| `via` | none | `Via` header value; omitted, no `Via` is added. |
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
  ├─ delete hop-by-hop headers             (RFC 9110 §7.6.1)
  ├─ set via                                (if configured)
  ├─ set headers                            (operator configuration)
  ├─ set credential()                       (read now, wins over everything)
  ├─ body: stream, or buffer on Firefox     (never for GET/HEAD)
  └─ fetch(base + path + query, { signal, redirect: "manual" })
        ├─ opaque redirect  -> 502, x-webrun-proxy: upstream-redirect
        ├─ throws           -> 502, x-webrun-proxy: upstream-unreachable
        └─ otherwise        -> upstream status, headers and streamed body
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

Hop-by-hop headers are always dropped: `connection`, `keep-alive`,
`proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
`transfer-encoding`, `upgrade`.

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

### Failures are responses, not exceptions

| Situation | Response |
| --- | --- |
| Upstream answers with a redirect | `502`, `x-webrun-proxy: upstream-redirect`, body `upstream redirected; the proxy does not follow redirects` |
| Network error, CORS refusal, body already read, any other throw | `502`, `x-webrun-proxy: upstream-unreachable`, body `upstream <base> could not be reached: <message>` and a line suggesting the upstream may not permit cross-origin requests |

Redirects are not followed (`redirect: "manual"`). In a browser that yields an
opaque redirect with status `0`, and `new Response(body, { status: 0 })`
throws, which would otherwise surface as `upstream-unreachable`. The proxy
checks for it first and reports it as a redirect.

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
