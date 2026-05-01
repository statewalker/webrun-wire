# @statewalker/webrun-site-builder

Compose a `(Request) ⇒ Response` handler from three ingredients:

- **Static files** from any [`@statewalker/webrun-files`](../../..
  /webrun-files/packages/webrun-files) source — memory, Node FS,
  S3, the browser's File System Access API, or a `CompositeFilesApi`
  stitching several together.
- **Dynamic endpoints** registered as
  `(Request, env) ⇒ Response` functions with URLPattern-based
  matching (`/todo/:id`, `/api/*`, …). `env` carries the per-request
  `params` plus any builder-level values registered via `setEnv`
  (DB connections, FilesApi instances, secrets, …).
- **Auth hooks** — pluggable predicates running before routing. Ships
  with an HTTP basic-auth factory; anything fetch-shaped can be
  layered on top.

The builder returns a plain fetch handler, so you drop it into
`@statewalker/webrun-http-browser`, `@statewalker/webrun-http`,
a Node / Deno / Bun server, or a Cloudflare Worker — same code.

## Why it exists

Static-site generators, small service backends, and in-browser app
demos keep re-solving the same problem: *serve these files, plus a
couple of dynamic routes, maybe guarded by auth*. The webrun stack
already has the pieces — what's missing is a tiny glue layer that
ties them together without a framework.

This package is that glue. It's intentionally framework-free (no Hono,
no Express, no middleware chain): `URLPattern` handles routing, a
small MIME map labels files, `FilesApi.stats()` + `read({start, length})`
handle Content-Length + `Range` requests, and auth is a single hook
returning a short-circuiting `Response`.

## How to use

```sh
npm install @statewalker/webrun-site-builder @statewalker/webrun-files
```

(You'll also need a concrete `FilesApi` — e.g.
`@statewalker/webrun-files-mem`, `@statewalker/webrun-files-node`,
`@statewalker/webrun-files-s3`, or
`@statewalker/webrun-files-browser`.)

### Exports

| Export | Purpose |
| --- | --- |
| `SiteBuilder` | Fluent builder. Chain `setFiles` / `setEndpoint` / `setAuth` / `setEnv` / `setErrorHandler` then `build()` to get a `SiteHandler`. |
| `newBasicAuth(credentials, opts?)` | Factory producing an `AuthPredicate` that checks HTTP basic credentials and challenges with `401 WWW-Authenticate: Basic`. |
| `newServeFiles(filesApi, opts?)` | Standalone file-serving function: `(request, path) ⇒ Response`. Used internally by `.setFiles`, exposed for advanced composition. |
| `getMimeType(path)` | Resolve a `Content-Type` from a file extension; falls back to `application/octet-stream`. |
| `newRouteMatcher(pattern, method?)` | Thin `URLPattern` wrapper returning extracted groups or `null`. Exposed for building custom layers. |
| `SiteHandler`, `EndpointHandler`, `EndpointEnv`, `AuthPredicate`, `ErrorHandler` | Type aliases for the contract surface. |

## Examples

### Minimal static site

```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SiteBuilder } from "@statewalker/webrun-site-builder";

const files = new MemFilesApi({
  "/index.html": "<!doctype html><h1>Hello</h1>",
  "/style.css": "h1 { color: navy }",
});

const handler = new SiteBuilder().setFiles("/", files).build();
// → pass `handler` to any fetch-shaped transport.
```

### Static + dynamic API

```ts
import { SiteBuilder } from "@statewalker/webrun-site-builder";

const handler = new SiteBuilder()
  .setFiles("/", files)
  .setEndpoint("/api/todo/:id", "GET", async (_req, env) =>
    Response.json({ id: env.params.id, title: "buy milk" }),
  )
  .build();
```

Endpoints are checked **before** files, so an endpoint at `/api/...`
will answer even if `files` contains an `api/` folder.

### Sharing values across endpoints with `setEnv`

`setEnv` merges values into the `env` bag every endpoint receives,
so handlers don't have to close over module-level state:

```ts
const handler = new SiteBuilder()
  .setEnv({ db, secrets, files })
  .setEndpoint("/api/todo/:id", "GET", async (_req, env) => {
    const row = await env.db.todo.get(env.params.id);
    return Response.json(row);
  })
  .build();
```

`env` is `{ ...registeredValues, params }` — `params` always wins, so
there is no "what if a key is named `params`" foot-gun. The bag is
snapshotted at `build()` time; later `setEnv` calls don't leak into
already-built handlers.

### Multiple file roots

`setFiles` takes a prefix so you can mount several `FilesApi`
implementations side-by-side on the same site:

```ts
const serverFiles = new MemFilesApi({ "/api/index.js": "export default…" });
const clientFiles = new MemFilesApi({ "/index.html": "<!doctype…" });

const handler = new SiteBuilder()
  .setFiles("/server", serverFiles)
  .setFiles("/client", clientFiles)
  .setEndpoint("/api/*", async (request) => {
    const { default: run } = await import(`${base}/server/api/index.js`);
    return run(request);
  })
  .build();
```

(The dynamic-import pattern above is what the
[`apps/site-builder-demo`](../../apps/site-builder-demo) example
uses on top of `@statewalker/webrun-http-browser`'s relay — the
`server/api/index.js` file is served as JS by `serverFiles`, then
`import()`-ed from the page and invoked per request.)

### Basic auth on a path

```ts
import { newBasicAuth, SiteBuilder } from "@statewalker/webrun-site-builder";

const handler = new SiteBuilder()
  .setAuth("/admin/*", newBasicAuth({ tom: "!jerry!", bob: "*marley*" }))
  .setFiles("/", files)
  .setEndpoint("/admin/stats", async () => Response.json({ hits: 42 }))
  .build();
```

The `newBasicAuth` factory handles the `Authorization: Basic …`
header: missing or invalid credentials return a 401 with
`WWW-Authenticate`; valid credentials let the request through to the
next layer.

### Custom auth (bearer / JWT / API key / …)

`setAuth` takes any predicate of shape
`(Request) ⇒ Response | undefined | Promise<Response | undefined>`.
Anything returning a `Response` short-circuits; `undefined` lets the
request through.

```ts
.setAuth("/api/*", async (request) => {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (!token || !(await verifyJwt(token))) {
    return new Response("Unauthorized", { status: 401 });
  }
  // undefined → allowed through
})
```

### Error handler

```ts
.setErrorHandler((error, request) => {
  console.error(`[${request.method} ${request.url}]`, error);
  return new Response("Something went wrong", { status: 500 });
})
```

Default is a plain `500 Internal Server Error` when any layer throws.

## Internals

### Dispatch order

On each request, the handler built by `.build()` runs three layers in
this fixed order:

1. **Auth** — every registered predicate whose pattern matches the
   request runs in registration order. The first one that returns a
   `Response` wins (typical: `401`). Predicates that return
   `undefined` fall through.
2. **Endpoints** — registered patterns + methods are checked in order;
   first match wins. `method` defaults to `"*"` (any method) when the
   two-argument overload is used.
3. **Files** — registered prefixes are checked in order; first prefix
   that is a real prefix of the URL path wins. The sub-path under the
   prefix is passed to the `FilesApi`. A sub-path that resolves to a
   directory returns `404` unless `directoryIndex` is explicitly
   configured (e.g. `{ directoryIndex: "index.html" }`).
4. **Fallback** — `404 Not Found`.

Any uncaught throw in any layer is routed to the error handler.

### File serving

`serve-files.ts` implements:

- `GET` returns the file with `Content-Type` from the extension map,
  `Content-Length` from `FilesApi.stats().size`, streaming body from
  `FilesApi.read()`.
- `HEAD` returns the same headers but no body.
- `Range: bytes=<start>-<end>` returns `206 Partial Content` with a
  `Content-Range` header and a slice produced by
  `FilesApi.read({start, length})`. Suffix (`-N`) and open-ended
  (`N-`) forms are supported. Multi-range is rejected with `416`.
- Other methods return `405 Method Not Allowed` with `Allow: GET, HEAD`.
- Directory paths return `404` by default. Opt into the conventional
  static-site fallback with `{ directoryIndex: "index.html" }`; if set
  but the index is missing the response is still `404`.

### URL patterns

`match-route.ts` wraps the standard `URLPattern` API. Named params
(`:id`) and wildcards (`*`, `:rest*`) are both exposed in the
returned params object; wildcards appear under numeric keys
(`"0"`, `"1"`, …). Matching ignores the query string and fragment.
Methods are compared case-insensitively; `*` and `ALL` match every
verb.

### Basic auth

`basic-auth.ts` implements RFC 7617 (`charset=UTF-8`):

- Decodes `Authorization: Basic <base64>` using UTF-8 (browsers send
  UTF-8-encoded credentials).
- Compares passwords with a length-independent loop so timing doesn't
  leak a matching prefix.
- Returns a fresh `Response` on every failure (challenge bodies can
  only be consumed once, so cloning per-call is required).

### Design notes

- **No middleware chain.** The three layers are fixed; extension
  lives inside endpoint handlers (wrap them to add logging, CORS,
  etc.). Keeping the dispatch loop small makes the cost of
  composition easy to reason about.
- **Prefix-based file mounts.** Prefix normalization strips trailing
  slashes and ensures a leading slash; the empty prefix means "mount
  at root". Matching only accepts a prefix if the URL path either
  equals it or starts with `prefix + "/"` — so `/server` doesn't
  accidentally match `/serverless`.
- **Env as a separate argument.** Endpoint handlers receive
  `(request, env)` rather than having params grafted onto the request.
  `env` always carries the URL `params` plus any builder-level values
  from `setEnv`, so handlers can read shared dependencies without
  closing over module state. The `Request` contract stays untouched,
  so handlers still double as standalone fetch handlers.
- **Auth is a hook, not a class.** Basic auth is one line —
  `.setAuth("/x", newBasicAuth({...}))`. JWT / bearer / API keys
  are just other predicate functions. No plugin architecture.
- **Peer dep only on `FilesApi` interface.** The FilesApi type is
  erased at compile time; the built bundle contains zero bare
  imports. Consumers pick any FilesApi implementation they want.

### Constraints

- **URLPattern required.** Node 18+ and all modern browsers ship
  it. For older Node, pre-load `urlpattern-polyfill` before
  importing this package.
- **Exact-path file serving.** A request whose resolved path is a
  directory returns `404` unless you opt in to a `directoryIndex`.
  No HTML file listings either; add a `setEndpoint("/browse/*", …)`
  if you need them.
- **No ETag / conditional GET.** `Last-Modified` and `If-None-Match`
  aren't produced — caching relies on `Content-Length` + fresh
  fetches. Add a custom endpoint layer if you need full cache
  negotiation.

### Dependencies

Runtime: **zero**. `@statewalker/webrun-files` is a peer dependency
(type only).

Dev: `@statewalker/webrun-files-mem` (for tests), TypeScript,
vitest, rolldown, rimraf, catalog versions from the monorepo root.

## Scripts

```sh
pnpm test        # vitest run
pnpm run build   # rolldown + tsc --emitDeclarationOnly
pnpm lint        # biome check src tests
```

## License

MIT © statewalker
