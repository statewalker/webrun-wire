# webrun-wire

**Move `Request`, `Response`, and async iterators over any byte channel —
MessagePort, WebSocket, ServiceWorker, in-process pipe, real HTTP —
with the same handler code on both ends.**

`webrun-wire` is a pnpm workspace that builds up, layer by layer, the
ability to write ordinary `(Request) ⇒ Response` handlers and RPC
service objects and run them anywhere bytes can flow. The "server" can
live in the same tab, in a sibling tab, inside a relay iframe, behind a
MessagePort, over a WebSocket, or on a real HTTP endpoint — callers use
standard `fetch()` and don't know the difference.

## Why it exists

The web platform gives browsers everything they need to *be* an HTTP
server: `Request`, `Response`, `ReadableStream`, `ServiceWorker`. What's
missing from the raw APIs is:

1. **A portable wire format** so you can move HTTP semantics over any
   byte channel (MessagePort, WebSocket, IPC, in-memory).
2. **ServiceWorker plumbing** — URL routing, MessageChannel wiring,
   recovery after SW restarts — and a way to use a SW from a page that
   isn't on the SW's origin.
3. **Stream primitives** (backpressure-aware iterators, WHATWG
   ReadableStream ↔ async iterator) shared across all the above without
   duplication.
4. **A service-RPC layer** that takes a plain object and exposes its
   methods as HTTP endpoints — same code running over real HTTP, an
   in-browser SW, a MessagePort, or a WebSocket.

This workspace solves all four as small, composable packages, each
publishable on its own and each carrying zero runtime dependencies
beyond other `@statewalker/webrun-*` packages in the same workspace.

## Typical use cases

- **In-browser full-stack prototypes** — back-end and client live in the
  same page, no external services to start.
- **Notebook / Observable / unpkg demos** — ship a working app where the
  reader doesn't have to install anything.
- **Local-disk or OPFS servers** — expose File System Access API content
  as a plain HTTP site you can `<iframe>` or `fetch()`.
- **Offline-first apps** — your back-end is literally a JS function; it
  works without network.
- **WebSocket-backed services** — write ordinary HTTP handlers, run them
  over a persistent socket.
- **Portable handlers** — the same async `(Request) ⇒ Response` function
  runs here today and in Deno / Cloudflare Workers / Node tomorrow.

## Dependency graph

```
webrun-streams        (foundation — iterator + stream + error + text/jsonl/lines primitives)
webrun-msgpack        (foundation — length-prefixed MessagePack frame codec)
    ▲
    ├── webrun-ports              (MessagePort RPC)
    │       ▲
    │       └── webrun-ports-ws   (WebSocket ↔ MessagePort bridge)
    │
    ├── webrun-http               (Request/Response over any byte channel)
    │       ▲
    │       ├── webrun-http-browser   (ServiceWorker hosting, relay mode)
    │       └── webrun-rpc-http       (service-RPC on top of webrun-http)
    │
    ├── webrun-site-builder       (files + endpoints + auth → (Request)⇒Response)
    │       ▲
    │       └── webrun-site-host  (SiteBuilder + SwHttpAdapter wired up in one call)
    │           (peer: @statewalker/webrun-files for the FilesApi interface)
    │
    └── (all of the above use webrun-streams for chunks + errors;
         scanners / chat pipelines additionally use webrun-msgpack for framing)
```

Every arrow is a `workspace:*` dep. Nothing deeper than
`webrun-streams` has runtime dependencies outside this repo except
`webrun-http-browser`, which pulls in `idb-keyval` (≈1 KB) to survive
SW restarts.

## Packages

### [`@statewalker/webrun-streams`](./packages/webrun-streams)

Async-iterator and `ReadableStream` primitives:

- `collect` / `collectBytes` / `collectString` — drain an async iterable into an array / `Uint8Array` / `string` (zero-copy when possible).
- `encodeText` / `decodeText` — UTF-8 `string` ↔ `Uint8Array` streams.
- `splitLines` / `joinLines` — line splitting over `string` streams (cross-chunk safe) and reverse.
- `encodeJsonl` / `decodeJsonl` — JSON values ↔ `\n`-delimited string stream.
- `map` — stream-map over an `AsyncIterable<T>`.
- `newAsyncGenerator` — backpressure-aware queue generator that turns imperative `next`/`done` callbacks into an async generator.
- `sendIterator` / `recieveIterator` — a `{done, value, error}` chunk protocol for shipping an async iterator across any transport.
- `toReadableStream` / `fromReadableStream` — one-way converters between `AsyncIterator<Uint8Array>` and `ReadableStream<Uint8Array>`.
- `serializeError` / `deserializeError` — preserve `Error` stack and custom fields across JSON / structured-clone boundaries.

Zero runtime deps. Every other package in the workspace depends on it.

### [`@statewalker/webrun-msgpack`](./packages/webrun-msgpack)

Length-prefixed MessagePack frame codec for async iterables:

- `encodeMsgpack` / `decodeMsgpack` — stream arbitrary values as `[4-byte BE length][msgpack payload]` frames; decoder buffers across chunk boundaries and never yields a partial trailing frame.
- `encodeFloat32Arrays` / `decodeFloat32Arrays` — zero-copy specialisation for `Float32Array` streams (the msgpack `bin` payload is reinterpreted as floats).

One runtime dep: `@ygoe/msgpack`. Used by downstream scanners and chat pipelines for value framing over any byte transport.

### [`@statewalker/webrun-ports`](./packages/webrun-ports)

MessagePort utilities — request/response, streaming, bidirectional calls
— multiplexed over a single `MessagePort` via a `channelName` tag.

- `callPort` / `listenPort` — request/response with timeout.
- `send` / `recieve` — async-iterator streams.
- `ioSend` / `ioHandle` — bidirectional half-duplex primitives.
- `callBidi` / `listenBidi` — high-level full-duplex streaming calls.

Zero runtime dependencies. The narrow-waist transport any higher-level
MessagePort protocol can build on.

### [`@statewalker/webrun-ports-ws`](./packages/webrun-ports-ws)

**WebSocket ↔ MessagePort bridge.** Wire a `WebSocket` to a
`MessagePort` with `bindWebSocketToPort(ws, port)` and every helper in
`webrun-ports` (request/response, streaming, bidi) runs unchanged.
Transport-neutral: JSON text frames, binary as transferable
`ArrayBuffer`, idempotent cleanup, works with browser `WebSocket` or
Node's [`ws`](https://www.npmjs.com/package/ws) package. No RPC layer,
no new wire format.

Zero runtime dependencies.

### [`@statewalker/webrun-http`](./packages/webrun-http)

Transport-agnostic `Request` / `Response` streaming over async
iterators. Two layers:

- **Stubs** — `newHttpClientStub` / `newHttpServerStub` (de)serialise
  HTTP envelopes against any `(envelope) ⇒ envelope` transport you
  provide.
- **Pipes** — `newHttpServer` / `newHttpClient` give you a server that
  is `AsyncIterable<Uint8Array> ⇒ AsyncIterable<Uint8Array>`, and a
  client that wires a `Request` through such a pipe.

Plus `HttpError`, and `toReadableStream` / `fromReadableStream` helpers
re-exported from `webrun-streams`.

Zero runtime dependencies. Peers on standard `Request` / `Response` /
`ReadableStream` / `TextEncoder` / `TextDecoder`.

### [`@statewalker/webrun-http-browser`](./packages/webrun-http-browser)

ServiceWorker-based HTTP server that runs entirely in the browser.
Register handlers in JavaScript, call them with standard `fetch()` /
`Request` / `Response`.

Two operating modes:

- **Same-origin** (`.../sw` subpath) — your app registers its own SW
  next to its pages and mounts handlers under `<scope>/<key>/…`.
- **Relay** (main entry) — a SW running at a shared relay origin handles
  requests for any page that embeds a hidden relay iframe. Cross-origin
  friendly; works from notebooks, Observable, unpkg, third-party hosts.

See
[`packages/webrun-http-browser/README.md`](./packages/webrun-http-browser/README.md)
for architecture, public API, design notes, constraints, and runnable
demos (Hono-routed dynamic site and a File System Access API browser).

### [`@statewalker/webrun-rpc-http`](./packages/webrun-rpc-http)

**HTTP-based service RPC.** Expose plain object methods as a standard
`(Request) ⇒ Response` handler; call them from anywhere with `fetch`:

- `newRpcServer(services, {path?})` → a webrun-http handler that
  routes `GET /`, `GET /{service}`, `GET|POST /{service}/{method}` into
  method calls.
- `newRpcClient({baseUrl, fetch?})` → `{ loadService<T>(name) }` with
  lazy descriptor caching; typed method proxies round-trip through
  `fetch`.

Because the server is a webrun-http handler and the client takes an
injectable `fetch`, the same RPC code runs unchanged over real HTTP, an
in-browser ServiceWorker, a MessagePort bridge, or a WebSocket — wire it
to whichever transport fits the deployment.

Depends on `@statewalker/webrun-streams` for error serialization.

### [`@statewalker/webrun-site-builder`](./packages/webrun-site-builder)

**Compose a `(Request) ⇒ Response` site** from three ingredients:
static files mounted from any `FilesApi` (memory / Node FS / S3 /
browser FSAA / composite), dynamic endpoints with URLPattern-based
routing, and pluggable auth hooks (ships with an HTTP basic-auth
factory):

```ts
new SiteBuilder()
  .setFiles("/", files)
  .setAuth("/admin/*", newBasicAuth({ tom: "!jerry!" }))
  .setEndpoint("/api/todo/:id", "GET", handler)
  .build(); // ⇒ (Request) ⇒ Response
```

The builder is deliberately framework-free: URLPattern for routing,
a small MIME map, `Range`/`HEAD` support driven by
`FilesApi.stats()` + `read({start, length})`. Zero runtime deps
beyond a peer `@statewalker/webrun-files`.

### [`@statewalker/webrun-site-host`](./packages/webrun-site-host)

**One-call in-browser hosting** for a `webrun-site-builder` site.
`HostedSiteBuilder` wraps `SiteBuilder` + `SwHttpAdapter` into a
single fluent API — you register files, endpoints, and auth hooks the
same way, and `.build()` takes care of the SW registration, URL
rewriting, and routing under a site key:

```ts
const site = await new HostedSiteBuilder()
  .setSiteKey("demo")
  .setFiles("/client", clientFiles)
  .setFiles("/server", serverFiles)
  .setServerRunner("/api", "/server/api/index.js")
  .build();
// site.baseUrl   → http://localhost:5173/demo/
// site.stop()    unhooks the handler
```

`setServerRunner(pattern, modulePath)` inlines the common pattern of
"the `/api` endpoint is a JS module served by my own site" — the
builder generates a dynamic-import endpoint under the hood.

## Runnable demos

| Demo | Path | What it shows |
| --- | --- | --- |
| **site-builder-demo** | [`apps/site-builder-demo`](./apps/site-builder-demo) | Vite + TypeScript app; `HostedSiteBuilder` mounts a full site (static client + `/api` dynamic-import endpoint + iframe preview) in ~40 lines. Highest-level wrapping; server-side code is a JS file served by the site itself. |
| **p2p cross-app HTTP demo** | [`apps/p2p-relay`](./apps/p2p-relay), [`apps/p2p-site-server`](./apps/p2p-site-server), [`apps/p2p-site-client`](./apps/p2p-site-client) | Two browser apps exchange HTTP (including SSE) over a direct libp2p WebRTC link, bootstrapped through a tiny localhost Circuit Relay v2. No domains, no TLS certs at the application layer. |
| Hono dynamic site | [`packages/webrun-http-browser/demo/demo-1.html`](./packages/webrun-http-browser/demo/demo-1.html) | A Hono router running in the browser as the back-end for a relay-SW-hosted site. Demonstrates relay mode + full-framework compatibility. |
| Local-disk file server | [`packages/webrun-http-browser/demo/demo-2.html`](./packages/webrun-http-browser/demo/demo-2.html) | User picks a folder via `showDirectoryPicker`; the relay SW exposes its contents as a browsable in-browser HTTP site. ~20-line handler. |
| Minimal same-origin SW | [`packages/webrun-http-browser/public/index.html`](./packages/webrun-http-browser/public/index.html) | The unwrapped `SwHttpAdapter` pattern, ~40 lines of inline JS. Good baseline for debugging the SW lifecycle. |

Each demo has a "Why it's interesting" blurb in its neighbouring
README or inside the relevant package README.

## Putting it together

The packages are designed to compose into end-to-end stacks. A few
concrete combinations:

| Use case | Stack |
| --- | --- |
| In-browser service RPC with offline-capable `fetch()` | `webrun-rpc-http` + `webrun-http-browser` (same-origin mode) + `webrun-http` |
| Cross-origin RPC from an embed (Observable, unpkg) | `webrun-rpc-http` + `webrun-http-browser` (relay mode) + `webrun-http` |
| Static site + dynamic API + auth, served from anywhere | `webrun-site-builder` + any `FilesApi` + a transport of your choice |
| In-browser static site + dynamic API with zero SW boilerplate | `webrun-site-host` — wraps the builder + the SW adapter in one `.build()` call |
| Node ↔ browser RPC over a WebSocket | `webrun-ports` + `webrun-ports-ws` on each end; optionally pipe `webrun-http` through for `Request`/`Response` semantics |
| Unit tests for an RPC service | `webrun-rpc-http` with `fetch: (req) => handler(req)` — no network at all |
| Deploying the same handler to a real edge runtime | `webrun-rpc-http` handler drops straight into Deno / Cloudflare Workers / Bun |

## Workspace

```sh
pnpm install
pnpm test              # turbo runs `test` in every package
pnpm run build         # turbo runs `build` in every package
pnpm lint              # biome check .
pnpm format:fix        # biome check --write --unsafe .
```

Tooling: **pnpm workspace**, **turborepo**, **biome**, **vitest**,
**rolldown**, **TypeScript**. No eslint / prettier / rollup / mocha.

### Self-contained bundles

Every package emits a single ESM bundle at `dist/index.js` with **zero
bare import specifiers** surviving into the output (workspace deps are
inlined). Packages load cleanly from a static host without an import
map or extra bundler on the consumer side.

The browser package additionally ships IIFE bundles for its SW
runtimes — loadable via classic `importScripts(...)`.

## Publishing

Via [Changesets](./PUBLISHING.md).

## License

MIT © statewalker
