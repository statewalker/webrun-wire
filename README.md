# webrun-wire

**Move `Request`, `Response`, and async iterators over any byte channel —
MessagePort, WebSocket, WebRTC, libp2p, LiveKit, ServiceWorker, in-process pipe,
real HTTP — with the same handler code on both ends.**

`webrun-wire` is a pnpm workspace that builds up, layer by layer, the ability to
write ordinary `(Request) ⇒ Response` handlers and RPC service objects and run
them anywhere bytes can flow. The "server" can live in the same tab, in a
sibling tab, inside a relay iframe, behind a MessagePort, over a WebSocket, on
the far side of a peer-to-peer link, or on a real HTTP endpoint — callers use
standard `fetch()` and don't know the difference.

## Why it exists

The web platform gives browsers everything they need to *be* an HTTP server:
`Request`, `Response`, `ReadableStream`, `ServiceWorker`. What's missing from the
raw APIs is:

1. **A portable wire format** so you can move HTTP semantics over any byte
   channel (MessagePort, WebSocket, WebRTC, IPC, in-memory).
2. **ServiceWorker plumbing** — URL routing, MessageChannel wiring, recovery
   after SW restarts — and a way to use a SW from a page that isn't on the SW's
   origin.
3. **Stream primitives** (backpressure-aware iterators, WHATWG
   `ReadableStream` ↔ async iterator) shared across all the above without
   duplication.
4. **A service-RPC layer** that takes a plain object and exposes its methods as
   HTTP endpoints — the same code running over real HTTP, an in-browser SW, a
   MessagePort, or a WebSocket.

This workspace solves all four as small, composable packages, each publishable
on its own.

## Typical use cases

- **In-browser full-stack prototypes** — back-end and client live in the same
  page, no external services to start.
- **Notebook / Observable / unpkg demos** — ship a working app where the reader
  doesn't have to install anything.
- **Local-disk or OPFS servers** — expose File System Access API content as a
  plain HTTP site you can `<iframe>` or `fetch()`.
- **Offline-first apps** — your back-end is literally a JS function; it works
  without network.
- **Browser-to-browser apps** — two tabs on two machines exchange HTTP and SSE
  over WebRTC, libp2p or a LiveKit room, with no server in the data path.
- **WebSocket-backed services** — write ordinary HTTP handlers, run them over a
  persistent socket.
- **Portable handlers** — the same async `(Request) ⇒ Response` function runs
  here today and in Deno / Cloudflare Workers / Node tomorrow.

## Install

Every package is published independently under the `@statewalker/` scope. Take
only the layers you need:

```sh
# stream primitives — the foundation everything else builds on
npm install @statewalker/webrun-streams

# HTTP over any Duplex, plus a transport to carry it
npm install @statewalker/webrun-http-streams @statewalker/webrun-streams-ws

# compose a site, host it in a browser ServiceWorker
npm install @statewalker/webrun-site-builder @statewalker/webrun-site-host @statewalker/webrun-files
```

All packages are ESM-only (`"type": "module"`). See
[Packaging](#packaging) for what the published artifacts actually contain.

## The seam

One type ties the whole workspace together, defined in
[`webrun-streams`](./packages/webrun-streams#the-duplex-seam):

```ts
type Duplex = (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => AsyncGenerator<Uint8Array>;
```

Bytes in, bytes out. A handler is a `Duplex`; a transport adapter produces one.
Because both sides have the same shape, an in-process test can wire
`const caller = handler` and run with no transport at all — and the same handler
then moves to a WebSocket, a WebRTC data channel or a libp2p stream by changing
one import. Iterator semantics carry every signal: consumer `.return()` runs the
producer's `finally`, a producer `throw` surfaces in the consumer's `for await`,
and normal exhaustion ends the other side.

Transports that are message-oriented (WebSocket, MessagePort, LiveKit, PeerJS)
supply a `ByteChannel` and let `emulateMux` provide many concurrent streams over
the one pipe. Transports that multiplex natively (WebRTC data channels, libp2p)
skip `emulateMux` entirely.

## Dependency graph

```
webrun-streams        (foundation — the Duplex seam, emulateMux, iterator/stream/error/text/jsonl primitives)
webrun-msgpack        (foundation — length-prefixed MessagePack frame codec)
    ▲
    ├── transport adapters — each supplies a Duplex over a concrete transport
    │     webrun-streams-port        (MessagePort — workers, iframes, in-process)
    │     webrun-streams-ws          (WebSocket)
    │     webrun-streams-livekit     (LiveKit data channel)
    │     webrun-streams-peerjs      (PeerJS DataConnection)
    │     webrun-streams-webrtc      (RTCDataChannel — native multi-stream, no mux)
    │     webrun-streams-libp2p      (libp2p streams — native multi-stream, no mux)
    │     webrun-streams-signaling   (P2P connection setup: PeerManager, QrSignaling, RoomManager)
    │     webrun-streams-conformance (the suite every adapter must pass)
    │
    ├── webrun-http-streams       (HTTP/1.1 request/response over a Duplex)
    │       ▲
    │       ├── webrun-http-browser   (ServiceWorker hosting, relay mode)
    │       └── webrun-rpc-http       (service-RPC on top of standard Request/Response)
    │
    └── webrun-site-builder       (files + endpoints + auth → (Request)⇒Response)
            ▲
            └── webrun-site-host  (SiteBuilder + SwHttpAdapter wired up in one call)
                (peer: @statewalker/webrun-files for the FilesApi interface)
```

Every arrow is a `workspace:*` dep. Runtime dependencies outside the workspace
are rare and listed per package below.

## Packages

### Foundations

| Package | Version | Summary |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](./packages/webrun-streams) | 0.1.1 | The `Duplex` / `ByteChannel` / `Connect` / `Serve` seam, the `PortMux` port multiplexer, `emulateMux`, and async-iterator primitives. **Zero dependencies.** |
| [`@statewalker/webrun-msgpack`](./packages/webrun-msgpack) | 0.1.1 | Length-prefixed MessagePack frame codec for async iterables. |

#### [`@statewalker/webrun-streams`](./packages/webrun-streams)

The foundation every other package depends on, and the only one with no
dependencies at all. It defines the seam described above and the primitives
that make it usable:

- **Seam** — `Duplex`, `Connect`, `Serve`, `ByteChannel`, `TransportClosedError`,
  and `emulateMux` (multi-stream over a single channel, with receiver-advertised
  credit flow control, a 64 KiB default MTU and an 8 MiB per-stream credit
  window).
- **Collectors** — `collect` / `collectBytes` / `collectString`.
- **Codecs** — `encodeText` / `decodeText`, `splitLines` / `joinLines`,
  `encodeJsonl` / `decodeJsonl`, `map`, `toChunks`.
- **Iterator plumbing** — `newAsyncGenerator` (backpressure-aware queue),
  `sendIterator` / `recieveIterator` (ship an iterator across any transport),
  `toReadableStream` / `fromReadableStream`.
- **Errors** — `serializeError` / `deserializeError`, preserving stack and
  custom fields across JSON and structured-clone boundaries.

#### [`@statewalker/webrun-msgpack`](./packages/webrun-msgpack)

Streams-safe MessagePack framing: `encodeMsgpack` / `decodeMsgpack` move
arbitrary values as `[4-byte BE length][msgpack payload]` frames, with a decoder
that buffers across chunk boundaries and never yields a partial trailing frame.
`encodeFloat32Arrays` / `decodeFloat32Arrays` are a zero-copy specialisation for
embedding pipelines. One runtime dependency, `@ygoe/msgpack`.

### HTTP

| Package | Version | Summary |
| --- | --- | --- |
| [`@statewalker/webrun-http-streams`](./packages/webrun-http-streams) | 0.2.1 | HTTP/1.1 request/response over a `Duplex`, in three layers. |
| [`@statewalker/webrun-http-browser`](./packages/webrun-http-browser) | 0.3.4 | ServiceWorker-based HTTP server for browsers, same-origin and relay modes. |
| [`@statewalker/webrun-rpc-http`](./packages/webrun-rpc-http) | 0.1.1 | Expose object methods as HTTP endpoints; call them with `fetch`. |

#### [`@statewalker/webrun-http-streams`](./packages/webrun-http-streams)

Moves real HTTP semantics across any `Duplex`, in three layers you can enter at
any level — `httpFetch` / `httpServe` on envelopes, `fetchOverDuplex` /
`serveFetchOverDuplex` on standard `Request` / `Response`, and
`DuplexSiteBuilder` for hosting a whole site over a `Connect`/`Serve` pair.

The wire format is conforming **HTTP/1.1**, verified against `node:http` in both
directions, behind a `MessageCodec` seam that also retains the legacy JSON
envelope so two peers can be upgraded in either order. The codec is deliberately
strict: every ambiguity is a refusal rather than a guess. See
[ADR-0006](./docs/adr/0006-http1-as-wire-format.md).

#### [`@statewalker/webrun-http-browser`](./packages/webrun-http-browser)

A ServiceWorker-based HTTP server that runs entirely in the browser. Register
handlers in JavaScript, call them with standard `fetch()`. Two operating modes:

- **Same-origin** (`/sw` subpath) — your app registers its own SW next to its
  pages and mounts handlers under `<scope>/<key>/…`.
- **Relay** (main entry) — a SW at a shared relay origin handles requests for
  any page that embeds a hidden relay iframe. Cross-origin friendly; works from
  notebooks, Observable, unpkg and third-party hosts.

Its [README](./packages/webrun-http-browser/README.md) covers architecture, the
full export surface, design notes, constraints, and runnable demos. One runtime
dependency outside the workspace: `idb-keyval` (≈1 KB), to survive SW restarts.

#### [`@statewalker/webrun-rpc-http`](./packages/webrun-rpc-http)

Service RPC with nothing but standard HTTP types:

- `newRpcServer(services, { path? })` → a `(Request) ⇒ Response` handler routing
  `GET /`, `GET /{service}`, `GET|POST /{service}/{method}` into method calls.
- `newRpcClient({ baseUrl, fetch? })` → `{ loadService<T>(name) }` with lazy
  descriptor caching and typed method proxies.

Because the server is a plain handler and the client takes an injectable
`fetch`, the same RPC code runs unchanged over real HTTP, an in-browser
ServiceWorker, a MessagePort bridge or a WebSocket — including
`fetch: (req) => handler(req)` for tests with no network at all.

### Sites

| Package | Version | Summary |
| --- | --- | --- |
| [`@statewalker/webrun-site-builder`](./packages/webrun-site-builder) | 0.1.1 | Compose files + endpoints + auth into a `(Request) ⇒ Response` site. |
| [`@statewalker/webrun-site-host`](./packages/webrun-site-host) | 0.1.1 | Host such a site behind a same-origin ServiceWorker in one call. |

#### [`@statewalker/webrun-site-builder`](./packages/webrun-site-builder)

Composes a site from three ingredients: static files mounted from any `FilesApi`
(memory / Node FS / S3 / browser FSAA / composite), dynamic endpoints with
URLPattern routing, and pluggable auth hooks.

```ts
new SiteBuilder()
  .setFiles("/", files)
  .setAuth("/admin/*", newBasicAuth({ tom: "!jerry!" }))
  .setEndpoint("/api/todo/:id", "GET", handler)
  .build(); // ⇒ (Request) ⇒ Response
```

Deliberately framework-free: URLPattern for routing, a small MIME map, and
`Range` / `HEAD` support driven by `FilesApi.stats()` + `read({start, length})`.
Peer dependency on `@statewalker/webrun-files`.

#### [`@statewalker/webrun-site-host`](./packages/webrun-site-host)

Owns *where* a site runs, while `SiteBuilder` owns *what* it does.
`HostedSiteBuilder` registers the same-origin ServiceWorker via `SwHttpAdapter`,
mounts the handler under a site key, and rewrites incoming URLs to site-relative
form:

```ts
const handler = new SiteBuilder()
  .setFiles("/client", clientFiles)
  .setEndpoint("/api", newServerRunner("/server/api/index.js", () => baseUrl))
  .build();

const site = await new HostedSiteBuilder()
  .setSiteKey("demo")
  .setHandler(handler)
  .build();
// site.baseUrl → http://localhost:5173/demo/
// site.stop()  → unhooks the handler
```

`newServerRunner(modulePath, getBaseUrl, env?)` covers the common "my `/api`
endpoint is a JS module served by my own site" pattern: it dynamic-imports the
module per request and calls its default export with `(request, env)`.

### Transport adapters

Each adapter binds the `Duplex` / `ByteChannel` seam to a concrete transport, so
the same handler runs over any of them. Most supply a `ByteChannel` and let
`emulateMux` provide concurrency; `webrun-streams-webrtc` opens one data channel
per `Duplex` and `webrun-streams-libp2p` uses libp2p's own multiplexing, so
neither needs it.

| Package | Version | Transport | Peer deps |
| --- | --- | --- | --- |
| [`@statewalker/webrun-streams-port`](./packages/webrun-streams-port) | 0.1.1 | `MessagePort` — workers, iframes, in-process pipes. Also carries a typed-JSON RPC tier (`callPort` / `listenPort` / `callBidi` / `ioSend`). | — |
| [`@statewalker/webrun-streams-ws`](./packages/webrun-streams-ws) | 0.1.1 | WebSocket. Browser-native, or Node via an injected constructor. | — |
| [`@statewalker/webrun-streams-webrtc`](./packages/webrun-streams-webrtc) | 0.1.1 | WebRTC data channels — one per call, with a 1-byte DATA/END/ERROR frame for half-close and error propagation. | — |
| [`@statewalker/webrun-streams-libp2p`](./packages/webrun-streams-libp2p) | 0.1.1 | libp2p streams, with an authenticated `remotePeer` available to handlers via `serveConnections`. | `libp2p`, `@libp2p/interface`, `@multiformats/multiaddr` |
| [`@statewalker/webrun-streams-livekit`](./packages/webrun-streams-livekit) | 0.1.1 | LiveKit reliable data channel — an SFU for when direct P2P won't connect. | `livekit-client` |
| [`@statewalker/webrun-streams-peerjs`](./packages/webrun-streams-peerjs) | 0.1.1 | PeerJS `DataConnection` — the shortest path to a browser-to-browser link. | `peerjs` |
| [`@statewalker/webrun-streams-signaling`](./packages/webrun-streams-signaling) | 0.1.1 | Not a transport but the *setup* for one: `PeerManager` (WebRTC discovery), `QrSignaling` (serverless offer/answer via QR), `RoomManager` (LiveKit membership). Yields `ByteChannel`s. | `livekit-client` (optional) |

### Testing

#### [`@statewalker/webrun-streams-conformance`](./packages/webrun-streams-conformance)

The shared, executable definition of "a correct adapter". Every adapter above
ships a one-line test file calling `describeDuplexAdapter(name, makePair)`, and
the suite asserts seven levels: envelope round-trip up to 10 MiB (L0), concurrent
calls (L1), half-close (L2), mid-stream cancellation running the handler's
`finally` (L3), error propagation with stack and custom fields intact (L4),
idempotent teardown (L5), and flow control against a slow consumer at a small
advertised window (L6). `makeLoopbackPair()` is the reference in-process pair
the suite self-tests against.

## Putting it together

| Use case | Stack |
| --- | --- |
| In-browser service RPC with offline-capable `fetch()` | `webrun-rpc-http` + `webrun-http-browser` (same-origin mode) |
| Cross-origin RPC from an embed (Observable, unpkg) | `webrun-rpc-http` + `webrun-http-browser` (relay mode) |
| Static site + dynamic API + auth, served from anywhere | `webrun-site-builder` + any `FilesApi` + a transport of your choice |
| In-browser static site + dynamic API with zero SW boilerplate | `webrun-site-host` — builder + SW adapter in one `.build()` |
| Node ↔ browser RPC over a WebSocket | `webrun-streams-ws` on each end; pipe `webrun-http-streams` through it |
| Browser ↔ browser HTTP + SSE, no server in the data path | `webrun-streams-signaling` to connect, `webrun-streams-webrtc` to carry, `webrun-http-streams` on top |
| The same, but through an SFU when P2P won't connect | `webrun-streams-livekit` in place of `-webrtc` |
| Unit tests for an RPC service | `webrun-rpc-http` with `fetch: (req) => handler(req)` — no network |
| A new transport | `webrun-streams-conformance` — make L0–L6 pass |
| Deploying the same handler to a real edge runtime | `webrun-rpc-http` handler drops straight into Deno / Workers / Bun |

## Runnable demos

| Demo | Path | What it shows |
| --- | --- | --- |
| **site-builder-demo** | [`apps/site-builder-demo`](./apps/site-builder-demo) | Vite + TypeScript app; `HostedSiteBuilder` mounts a full site (static client + `/api` dynamic-import endpoint + iframe preview) in ~40 lines. |
| **p2p cross-app HTTP demo** | [`apps/p2p-demo`](./apps/p2p-demo) | Node libp2p Circuit Relay v2 + a server page + a client page. Pages find each other through relay-mediated group discovery — no peer-id paste step — then exchange HTTP (including SSE) over a direct WebRTC link. `pnpm demo:p2p` boots all three. |
| **livekit cross-app HTTP demo** | [`apps/livekit-demo`](./apps/livekit-demo) | The same shape with a LiveKit room replacing the libp2p relay + WebRTC link. Boots a dev LiveKit server (Docker), a JWT token service, and two Vite pages. |
| site-builder + JSPM | [`apps/site-builder-jspm-demo`](./apps/site-builder-jspm-demo) | Bare import specifiers resolved in-browser via `@jspm/generator` and served from the in-browser site. |
| site-builder TSX spike | [`apps/site-builder-tsx-spike`](./apps/site-builder-tsx-spike) | `ServeFilesOptions.transform` as a per-mount response filter: sucrase transpiles `.ts` / `.tsx` on the fly. |
| Hono dynamic site | [`packages/webrun-http-browser/demo/demo-1.html`](./packages/webrun-http-browser/demo/demo-1.html) | A Hono router running in the browser as the back-end for a relay-SW-hosted site. |
| Local-disk file server | [`packages/webrun-http-browser/demo/demo-2.html`](./packages/webrun-http-browser/demo/demo-2.html) | `showDirectoryPicker` + a ~20-line handler exposing a local folder as a browsable HTTP site. |
| Minimal same-origin SW | [`packages/webrun-http-browser/public/index.html`](./packages/webrun-http-browser/public/index.html) | The unwrapped `SwHttpAdapter` pattern in ~40 lines. Good baseline for debugging the SW lifecycle. |

Each demo has a "Why it's interesting" blurb in its own README.

## Workspace

```sh
pnpm install
pnpm test              # turbo runs `test` in every package
pnpm run build         # turbo runs `build` in every package
pnpm lint              # biome check .
pnpm format:fix        # biome check --write --unsafe .
```

Tooling: **pnpm workspace**, **turborepo**, **biome**, **vitest**, **rolldown**,
**TypeScript**. Every package builds the same way — `rolldown -c` for the bundle,
`tsc --emitDeclarationOnly` for the types. No eslint / prettier / rollup / mocha.

## Packaging

All fifteen packages are ESM-only and resolve identically:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
}
```

Consumers get a built ESM bundle plus generated `.d.ts` — no TypeScript-aware
build step required on their side, and `node16` / `nodenext` resolution works.
Both `src` and `dist` ship in `files`, so sources remain available for
debugging and source maps.

**Bundle externals** are derived from each package's own manifest by
[`rolldown.preset.js`](./rolldown.preset.js): everything declared as a
`dependency` or `peerDependency` stays external, and nothing else does. npm
installs those for the consumer, so inlining them would only ship a second
copy — and a second copy of `@statewalker/webrun-streams` means a second
`TransportClosedError` class, quietly breaking `instanceof` across package
boundaries. Deriving the list from the manifest also stops it drifting, which
is what had happened: a deleted `@statewalker/webrun-ports`, a `peerjs` that
was never imported, a missing `@multiformats/multiaddr`, and four packages
inlining their workspace dependencies by omission.

**One documented exception:** `webrun-http-browser` inlines everything. Its own
shipped HTML loads the bundle straight from a static host with no import map
(`public-relay/relay.html` and both `demo/*.html` do
`import … from "../dist/index.js"`), and its two IIFE service-worker runtimes
are loaded through classic `importScripts(...)`, which cannot resolve a bare
specifier at all. The trade-off is a duplicated copy of `webrun-streams` inside
that bundle. It also ships IIFE bundles for those two SW runtimes
(`/relay-sw`, `/sw-worker`).

**Inside the workspace**, tooling short-circuits to source rather than `dist`:
`tsconfig.base.json` maps every `@statewalker/webrun-*` to `packages/*/src` via
`paths`, and [`vitest.config.ts`](./vitest.config.ts) builds the matching
`resolve.alias` list. Without that, tests would resolve through the `exports`
map into `dist` and silently run against the last build instead of the working
tree. Published consumers are unaffected — they only ever see `dist`.

## Publishing

Via [Changesets](./PUBLISHING.md).

## Cross-repo dependencies

| Repository | Packages used |
| --- | --- |
| [`webrun-files`](https://github.com/statewalker/webrun-files) | `@statewalker/webrun-files`, `@statewalker/webrun-files-mem` |

Cross-repo dependencies are declared `workspace:*` rather than `catalog:`. This
is deliberate: turbo derives its task graph from `workspace:` specifiers and does
**not** resolve `catalog:`, so a `catalog:` cross-repo dependency is invisible to
the scheduler and its consumer can be built before it.

## Documentation

- [`CONTEXT.md`](./CONTEXT.md) — domain model and bounded-context notes.
- [`docs/adr/`](./docs/adr) — architecture decision records.
- [`PUBLISHING.md`](./PUBLISHING.md) — release process.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.

## License

MIT © statewalker — see [LICENSE](./LICENSE).
