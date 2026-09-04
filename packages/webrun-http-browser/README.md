# @statewalker/webrun-http-browser

ServiceWorker-based HTTP server for browsers. You write ordinary
`(Request) ⇒ Response` handlers in JavaScript; a ServiceWorker intercepts
same-origin `fetch()` calls and routes them to your handlers — no network
round-trip, no external server, no bundler tricks required.

Two modes, picked by how the SW is hosted:

- **Same-origin** (`@statewalker/webrun-http-browser/sw`) — your app
  registers its own SW and mounts handlers next to the page.
- **Relay** (default entry) — a SW running at a shared relay origin
  (CDN / unpkg / your own host) serves requests for any page that embeds
  a hidden relay iframe. Cross-origin friendly.

## Why it exists

The browser already has everything needed to be an HTTP server: `Request`,
`Response`, `ReadableStream`, `ServiceWorker`. Two things are missing from
the raw platform APIs, and this package fills them:

1. **Plumbing for same-origin SW dispatch.** Browsers let a SW intercept
   `fetch` events, but you still have to build URL routing, MessageChannel
   wiring between the page and the SW, and recovery after SW restarts.
2. **A way to use a SW from a page that isn't on the SW's origin.** The
   relay mode lets *any* page (Observable, notebooks, a `file://` demo,
   unpkg, a third-party host) share a SW hosted somewhere else. The page
   never registers a SW of its own — it just embeds a hidden iframe.

Combining both modes means the same handler code works in an app you
control *and* in an embed you don't.

## Install

```sh
npm install @statewalker/webrun-http-browser
```

Browser-only — it needs `navigator.serviceWorker`, so a secure context
(`https://` or `localhost`) is required. No peer dependencies.

## How to use

```sh
npm install @statewalker/webrun-http-browser
```

| Subpath | Purpose |
| --- | --- |
| `@statewalker/webrun-http-browser` | Page-side relay API: `newRemoteRelayChannel`, `initHttpService`, `callHttpService`, `splitServiceUrl`, `initServiceWorker`, `newServiceWorkerPort`, `getRelayWindowMessageHandler`; the MessagePort call primitives (`callChannel`, `handleChannelCalls`, `newInvokationChannel`, `sendStream`, `handleStreams`, `newRegistry`); plus everything re-exported from `@statewalker/webrun-http-streams` (`HttpError`, the client/server stubs) and `@statewalker/webrun-streams` (stream and error helpers) |
| `@statewalker/webrun-http-browser/sw` | Same-origin adapter classes: `SwHttpAdapter` (page), `SwHttpDispatcher` (SW), `startHttpDispatcher` bootstrap |
| `@statewalker/webrun-http-browser/relay-sw` | IIFE bundle of the relay SW runtime — load via `importScripts` from a loader script in your relay origin |
| `@statewalker/webrun-http-browser/sw-worker` | IIFE bundle of the same-origin SW runtime — ditto, for same-origin apps |

## Examples

> Every example below needs a real browser: a ServiceWorker, and for relay
> mode an iframe on the relay origin. None of them run under Node, and
> ServiceWorkers only register over `http://localhost` or HTTPS. The runnable
> versions are in [`public/`](./public) and [`demo/`](./demo) — see
> [Running the bundled examples](#running-the-bundled-examples).

### Relay mode — cross-origin

Your page ↔ hidden relay iframe ↔ relay ServiceWorker. The relay SW claims
URLs shaped `<relay-origin>/~<service-key>/…` and forwards each request to
whichever page registered that `key`.

```ts
import {
  newRemoteRelayChannel,
  initHttpService,
  callHttpService,
} from "@statewalker/webrun-http-browser";

// 1. Embed the relay iframe and open a MessagePort into its SW.
const connection = await newRemoteRelayChannel({
  url: new URL("https://my-relay.example/public-relay/relay.html"),
});

// 2. Register a handler for service "FS".
const baseUrl = `${connection.baseUrl}~FS`;
await initHttpService(
  async (request) =>
    new Response(`Hello ${new URL(request.url).pathname}`),
  { key: "FS", port: connection.port },
);

// 3a. Any browser tab loading the service URL now hits your handler:
await fetch(`${baseUrl}/anything`);

// 3b. …or call it directly through the same port, bypassing `fetch`
//     (useful when the caller isn't on the relay origin):
const res = await callHttpService(
  new Request(`${baseUrl}/anything`),
  { key: "FS", port: connection.port },
);
```

[`demo/demo-1.html`](./demo/demo-1.html) wires this to a Hono router
serving a mini site; [`demo/demo-2.html`](./demo/demo-2.html) pipes a
local-disk folder (File System Access API) through it.

### Same-origin mode

Your page registers its own SW, handlers are local to the page:

```ts
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";

const KEY = "demo"; // also the first URL segment the SW routes here
const adapter = new SwHttpAdapter({
  key: KEY,
  serviceWorkerUrl: new URL("./sw-worker.js", import.meta.url).toString(),
});
await adapter.start();

const { baseUrl } = await adapter.register(`${KEY}/api/`, async (request) => {
  return new Response(JSON.stringify({ now: Date.now() }), {
    headers: { "Content-Type": "application/json" },
  });
});

// fetch(`${baseUrl}anything`) is intercepted by the SW.
```

The SW script itself ships as a pre-built IIFE bundle. Put a tiny loader
next to your app pages so the SW's default scope covers them:

```js
// public/sw-worker.js — served next to your app pages.
importScripts(
  "/path/to/node_modules/@statewalker/webrun-http-browser/dist/sw-worker.js",
);
```

The working example lives in [`public/`](./public).

### Running the bundled examples

```sh
pnpm run example:same-origin   # public/index.html    — same-origin SW demo
pnpm run example:relay-site    # demo/demo-1.html     — relay + Hono dynamic site
pnpm run example:relay-files   # demo/demo-2.html     — relay + local-disk file server
pnpm run serve                 # just a static server on :5173 (no auto-open)
```

Each `example:*` script builds first, starts a static server on `:5173`,
then opens the target page in the default browser. ServiceWorkers only
register over `http://localhost` or HTTPS, so always visit through
`http://localhost:5173/…` — `file://` won't work.

#### [`public/index.html`](./public/index.html) — minimal same-origin SW

The smallest possible in-browser HTTP server. The page registers
`public/sw-worker.js` (which `importScripts`es the shipped
`dist/sw-worker.js`), constructs a `SwHttpAdapter` with key `"demo"`,
and registers a single handler at `demo/api/` that returns JSON. The
page then makes a standard `fetch(baseUrl + "anything")` and logs the
result.

Why it's interesting:

- **No framework, no glue, ~40 lines of inline JS.** This is the
  unwrapped pattern — everything
  [`@statewalker/webrun-site-host`](../webrun-site-host) and
  [`@statewalker/webrun-site-builder`](../webrun-site-builder) build on
  top of. Useful as a reference for exactly what the SW lifecycle
  looks like at its lowest level.
- **Shows the SW-routing contract.** The adapter's `key: "demo"` is
  the first URL segment the SW uses to find this page's registration;
  `adapter.register(\`${KEY}/api/\`, ...)` mounts the handler prefix
  under the same key. The mapping is visible and inspectable — great
  for debugging your own SW-based code.

#### [`demo/demo-1.html`](./demo/demo-1.html) — relay + Hono dynamic site

A full-blown mini web site running in a single tab, behind the
**relay** ServiceWorker. The page spins up a Hono router with a
`/api/:name` endpoint and a static-file catch-all, registers it as
service `MY_SITE`, and embeds the service root in an iframe. Inside
the iframe, typing into an input fires `fetch("./api/" + name)` and
renders the JSON response — the whole back-end is the Hono app
running in the outer tab.

Why it's interesting:

- **An entire web framework running client-side.** Hono is a normal
  Node/Deno/CF-Workers framework — here it's loaded from esm.sh and
  mounted inside the browser with no server involvement. The
  `(Request) ⇒ Response` contract makes this transparent.
- **Relay mode = cross-origin friendly.** Because the SW lives at the
  relay origin (not the page's origin), this pattern also works when
  your page is served from Observable, unpkg, a notebook, or a static
  `file://` — places where registering your own SW isn't possible.
  The hidden relay iframe does the SW registration on your behalf.
- **Two ways to call the service.** The iframe uses plain `fetch()`
  through the SW; any other browser tab pointing at
  `<relay-origin>/~MY_SITE/...` is also routed to this tab's Hono
  app. Demonstrates that the page hosting the handler and the caller
  don't have to share an origin.

#### [`demo/demo-2.html`](./demo/demo-2.html) — FS Access API folder as a site

Click **Open folder**, grant read access, and any directory on your
local disk is exposed as an in-browser HTTP site under
`<relay-origin>/~FS/…`. The left panel shows a live file tree; clicking
a file loads it in the iframe preview. The service handler is a ~20-line
function that resolves paths via
[`FileSystemDirectoryHandle.getFileHandle`](https://developer.mozilla.org/docs/Web/API/FileSystemDirectoryHandle/getFileHandle)
and streams the file's bytes back through the SW.

Why it's interesting:

- **Zero installs, real files.** Browse arbitrary directories as if
  they were hosted — open a local project's `index.html` and it just
  runs. Relative URLs inside the hosted files resolve correctly because
  the SW serves every asset, CSS, and JS under the same origin.
- **Permissioned + sandboxed.** The browser's File System Access API
  provides the "backend" (read permission granted per-folder by the
  user); the relay SW provides the "network". You get the ergonomics
  of a local HTTP dev server without running one.
- **Directory picker + request router in <100 lines.** No build step,
  no tooling. Shows how small the glue between a platform API and a
  `(Request) ⇒ Response` handler can be.

## Exports

The package root re-exports everything from
[`@statewalker/webrun-streams`](../webrun-streams) and
[`@statewalker/webrun-http-streams`](../webrun-http-streams), so existing
imports keep working after those extractions. Its own surface is below.

### Relay mode

| Export | Kind | Purpose |
| --- | --- | --- |
| `newRemoteRelayChannel(opts?)` | function | Embeds the hidden relay iframe, handshakes a `MessageChannel`, resolves a `RemoteRelayChannel`. |
| `RemoteRelayChannelOptions` | interface | `baseUrl`, `url`, `container` — where the relay lives and what to append the iframe to. |
| `RemoteRelayChannel` | interface | `{ baseUrl, port, close() }`. |
| `initHttpService(handler, opts)` | function | Registers `handler` as the server for a service `key` on the relay. Returns a cleanup. |
| `callHttpService(request, opts)` | function | Sends a `Request` to the service under `key`; resolves its `Response`. |
| `ServiceOptions` | interface | `{ key: string; port: MessageTarget }` — shared by the two above. |
| `getRelayWindowMessageHandler(opts?)` | function | The `window.onmessage` handler that runs *inside* the relay iframe. |
| `RelayWindowHandlerOptions` | interface | `swUrl`, `scopeUrl` for that handler. |
| `splitServiceUrl(url, separator?)` | function | Splits a relay URL into service key + remaining path (default separator `~`). |
| `SplitServiceUrl` | interface | Its result shape. |

### ServiceWorker lifecycle

| Export | Kind | Purpose |
| --- | --- | --- |
| `initServiceWorker(opts)` | function | Registers a SW and resolves once it is activated **and controlling the page**. |
| `InitServiceWorkerOptions` | interface | `{ swUrl, scopeUrl?, type? }`. |
| `newServiceWorkerPort()` | function | A `MessagePort` that transparently bridges to the controlling SW. |

### Connection registry

| Export | Kind | Purpose |
| --- | --- | --- |
| `initializeConnection(opts)` | function | Sends `CONNECT` for a service `key`; resolves a `MessagePort`, or `null` if no such service. |
| `InitializeConnectionOptions` | interface | `{ key, communicationPort, ...extra }` — extra fields ride along in the CONNECT payload. |
| `registerConnectionsHandler(opts)` | function | Registers a `key` and answers inbound `CONNECT`s. Returns a cleanup that unregisters. |
| `RegisterConnectionsHandlerOptions` | interface | `{ key, handler, communicationPort }`. |

### Messaging primitives

| Export | Kind | Purpose |
| --- | --- | --- |
| `callChannel(target, type, data, port?)` | function | One typed request/response over a `MessageTarget`. |
| `handleChannelCalls(target, type, handler)` | function | Answer those calls. Returns an unsubscribe. |
| `ChannelCallHandler` | type | The handler signature the two above exchange. |
| `newInvokationChannel(opts)` | function | Multiplexed invocations over one target. |
| `InvocationChannel` / `NewInvocationChannelOptions` | interface | Its result and options. |
| `handleStreams(...)` / `StreamHandler<T>` | function / type | Stream-shaped invocations over the same channel. |
| `MessageTarget` / `MessageSource` / `MessageSink` / `MessageListener` | interface / type | The structural port view everything above accepts — a `MessagePort`, a `Worker`, or a SW bridge. Defined in [`@statewalker/webrun-streams`](../webrun-streams) and re-exported here. |
| `newRegistry(onError?)` | function | Small cleanup registry used for teardown. |
| `Registry` / `NewRegistryResult` / `CleanupAction` | interface / type | Its shapes. |

### HTTP over a port

| Export | Kind | Purpose |
| --- | --- | --- |
| `sendHttpRequest(port, request)` | function | Ship a `Request` over a `MessagePort`, await the `Response`. |
| `handleHttpRequests(port, handler)` | function | Serve an `HttpHandler` on the other end of one. |

### Subpath entry points

| Entry | Purpose |
| --- | --- |
| `@statewalker/webrun-http-browser/sw` | `SwHttpAdapter` — the same-origin ServiceWorker adapter. |
| `@statewalker/webrun-http-browser/relay-sw` | IIFE relay SW runtime, loadable via `importScripts(...)`. |
| `@statewalker/webrun-http-browser/sw-worker` | IIFE same-origin SW runtime, loadable via `importScripts(...)`. |

## Internals

### Source layout

```
src/
├── core/                          ┐
│   ├── data-calls.ts              │  Transport primitives over a
│   ├── data-channels.ts           │  `MessageTarget`: one-shot
│   ├── message-target.ts          │  `callChannel` / `handleChannelCalls`,
│   └── registry.ts                │  the request/response
│                                  │  `newInvokationChannel`, streaming
│                                  │  `sendStream` / `handleStreams` with
│                                  │  backpressure, and `newRegistry`.
│                                  │  Also re-exports
│                                  │  `@statewalker/webrun-streams`.
│                                  ┘
├── http/                          ┐
│   ├── http-send-recieve.ts       │  Browser-specific HTTP transport:
│   │                              │  `handleHttpRequests` /
│   │                              │  `sendHttpRequest` over `MessageTarget`s,
│   │                              │  built on the client/server stubs.
│   └── index.ts                   │  Re-exports
│                                  ┘  `@statewalker/webrun-http-streams`.
├── sw/                            ┐
│   ├── sw-dispatcher.ts           │  Same-origin mode:
│   │                              │  `SwPortHandler` (page) /
│   │                              │  `SwPortDispatcher` (SW side,
│   │                              │  IndexedDB-persisted client index).
│   ├── http-sw-dispatcher.ts      │  `SwHttpAdapter` /
│   │                              │  `SwHttpDispatcher` /
│   └── index.ts                   │  `startHttpDispatcher`.
│                                  ┘
├── relay/                         ┐
│   ├── index.ts                   │  Relay mode page-side:
│   │                              │  `newRemoteRelayChannel`,
│   │                              │  `initHttpService`,
│   │                              │  `callHttpService`,
│   │                              │  `getRelayWindowMessageHandler`.
│   ├── index-sw.ts                │  `startRelayServiceWorker` — the SW
│   │                              │  side (registry keyed by service key).
│   └── split-service-url.ts       │  `<base>/~<key>/<path>` parser.
│                                  ┘
├── index.ts                       — public entry: core + http + relay.
├── sw.ts                          — `./sw` subpath entry.
├── relay-sw.ts                    — relay SW bootstrap (IIFE target).
└── sw-worker.ts                   — same-origin SW bootstrap (IIFE target).
```

### Design notes

- **Two SW strategies**. Same-origin mode needs the SW to be served next
  to the app (scope-rooted loader); relay mode puts the SW anywhere and
  ferries messages through an iframe, at the cost of a `CONNECT`
  round-trip per call. Pick the stricter mode when you own the origin.
- **Adapter key = URL segment**. For the same-origin path, the adapter's
  `key` option **must match** the first URL segment the SW routes to it:
  if `key: "demo"` and the SW scope is `/public/`, handlers answer at
  `/public/demo/…`. The SW extracts the segment from the URL and looks up
  `handlersIndex` by key. This is why
  `adapter.register(\`${KEY}/api/\`, …)` prefixes the registration path
  with the same key.
- **IIFE for SW bundles**. The SW runtime bundles (`relay-sw.js`,
  `sw-worker.js`) are IIFE rather than ESM so a classic
  `importScripts(...)` loader script can pull them in. Registering as
  `{ type: "module" }` SWs would work but is subject to
  `Service-Worker-Allowed` header games for a scope wider than the
  bundle's directory.
- **ESM page-side bundles are self-contained**. `dist/index.js` and
  `dist/sw.js` inline their dependencies (`idb-keyval`,
  `@statewalker/webrun-http-streams`, `@statewalker/webrun-streams`) so a
  page can load them straight from a static host without a bundler or
  import map.
- **Streaming uses `newAsyncGenerator`** (from `@statewalker/webrun-streams`,
  via `recieveIterator`). The queue-based async generator gives explicit
  backpressure — each `next(value)` returns a `Promise<boolean>` that resolves
  once the consumer has dequeued — and drains in-flight producers on consumer
  exit.
- **SW client registry is IndexedDB-persisted**. Both `SwPortDispatcher`
  (same-origin) and `relay/index-sw.ts` keep their client-lookup tables in
  IndexedDB so a SW wake-up after idle doesn't lose its bindings.

### Constraints

- **Request bodies are buffered on Firefox.** The stubs this package uses
  (`newHttpClientStub` / `newHttpServerStub` from
  [`@statewalker/webrun-http-streams`](../webrun-http-streams)) stream request
  bodies wherever the runtime implements `Request.prototype.body`. Firefox
  does not (checked against 146), so on that browser the whole request body is
  buffered into memory on both the sending and the receiving side — a large
  upload is a proportionally large allocation, and a handler that wanted to
  stream its request body cannot. Response streaming is unaffected on every
  browser. See that package's README for the details and for the Safari
  caveat.
- **ServiceWorker scope rules apply.** A SW registered at `/public/sw-worker.js`
  only controls pages and fetches under `/public/`. If you need a broader
  scope, the SW script must be served with the
  `Service-Worker-Allowed` HTTP header, *or* live higher in the origin.
- **`http://localhost` or HTTPS only.** Browsers refuse to register SWs
  on other `http://` origins.
- **Relay mode needs an iframe-capable sandbox.** Pages with strict CSP
  that blocks `frame-src` to the relay origin can't use the relay path.
- **Consumer-side `fetch()` only works from pages under the SW's scope.**
  When your caller is on another origin, use `callHttpService(request,
  …)` — it reaches the SW through the iframe's MessagePort and bypasses
  the browser's fetch routing.

### Dependencies

Runtime:

- `@statewalker/webrun-http-streams` — the `newHttpClientStub` /
  `newHttpServerStub` pair this package's MessagePort transport is built
  on, plus `HttpError`. Workspace-local.
- `@statewalker/webrun-streams` — iterator/stream primitives and
  serialisable errors. Workspace-local.
- `idb-keyval` — tiny (<1 KB) IndexedDB KV used by both SW modes to keep
  client/service registrations across SW restarts.

Dev: TypeScript, vitest, rolldown, rimraf, `http-server` (for the
`example:*` scripts), `@types/node` (catalog versions from the monorepo
root).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
