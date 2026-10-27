# @statewalker/webrun-http-browser

## What it is

A ServiceWorker-based HTTP and WebSocket server for the browser. You write
ordinary `(Request) => Response` handlers in a page or in a Dedicated Worker; a
ServiceWorker intercepts `fetch()` calls and routes them to those handlers over
`MessagePort`s, with no network round-trip and no external server. Bodies
stream with backpressure in both directions, and an aborted `fetch` reaches the
handler as a cancellation. It has two modes:

- **Same-origin** (`./sw` + `./sw-worker`, and `./worker` in Dedicated
  Workers): your app registers its own worker next to its pages and mounts
  handlers under URL prefixes, in the page itself or in workers the page
  attaches.
- **Relay** (`.` + `./relay-sw` or `./relay-worker`): a worker hosted on a relay
  origin serves requests for any page that embeds a hidden relay iframe. The
  page never registers a worker of its own.

In both modes a handler can also accept WebSockets: a socket is carried by a
`MessagePort`, and the caller gets a class with the browser's `WebSocket` API.

## Why it exists

The browser already has `Request`, `Response`, `ReadableStream` and
ServiceWorkers. What it lacks is the plumbing between them:

1. **Same-origin dispatch.** A worker can intercept `fetch` events, but you
   still need URL routing, a `MessageChannel` between page and worker, recovery
   after the worker is stopped and restarted, and a way out when the page loads
   uncontrolled.
2. **A worker for a page that is not on the worker's origin.** Relay mode lets
   any page (a notebook, a CDN-hosted page, a third-party host) use a worker
   hosted elsewhere by embedding a hidden iframe.

The same handler code works in both modes.

## How to use

```sh
pnpm add @statewalker/webrun-http-browser
```

- **Peer dependencies:** none.
- **Environment:** browser only. Pages need `navigator.serviceWorker`, which
  requires a secure context (`https://` or `http://localhost`).

### Entry points

| Subpath | Format | Runs in | What it gives |
| --- | --- | --- | --- |
| `.` | ESM, `dist/index.js` + `.d.ts` | page, relay iframe | Relay page API (`newRemoteRelayChannel`, `initHttpService`, `callHttpService`, `callWebSocketService`, `relayWebSocketClass`, `getRelayWindowMessageHandler`, `splitServiceUrl`), ServiceWorker lifecycle helpers (`initServiceWorker`, `newServiceWorkerPort`, `awaitActiveServiceWorker`, `awaitServiceWorkerControl`, `handleClaimRequests`, `ServiceWorkerControlError`), everything `./sw` exports, the `MessagePort` call primitives, and everything re-exported from `@statewalker/webrun-streams` and `@statewalker/webrun-http-streams`. |
| `./sw` | ESM, `dist/sw.js` + `.d.ts` | page and worker | Same-origin classes: `SwHttpAdapter` (page), `SwHttpDispatcher` and `startHttpDispatcher` (worker), the WebSocket module (`createWebSocketClass`, `upgradeWebSocket`, ...), `serviceWorkerWebSocketClass`, the HTTP link layer (`connectHttpLink`, `serveHttpLink`), and the version-1 bases `SwPortHandler` / `SwPortDispatcher`. |
| `./worker` | ESM, `dist/worker.js` + `.d.ts` | Dedicated Worker | `serveHttpInWorker(handler)`, and the WebSocket helpers a handler needs (`upgradeWebSocket`, `isWebSocketUpgrade`, `requestedProtocols`, `createWebSocketClass`). |
| `./sw-worker` | IIFE, `dist/sw-worker.js`, no types | ServiceWorker | Prebuilt same-origin worker: calls `startHttpDispatcher({ self, log: console.log, ...self.HTTP_DISPATCHER_OPTIONS })`. Load it with `importScripts`. |
| `./relay-sw` | IIFE, `dist/relay-sw.js`, no types | ServiceWorker | Prebuilt relay worker: calls `startRelayServiceWorker(self, self.RELAY_OPTIONS ?? {})`. Load it with `importScripts`. |
| `./relay-worker` | ESM, `dist/relay-worker.js` + `.d.ts` | ServiceWorker | The relay worker runtime as a typed module, for a host that bundles its own worker: `startRelayServiceWorker`, `RelayServiceWorkerOptions`, `MountSpec`. Not re-exported from `.`, because it only runs inside a worker. |

The ESM subpaths also have a `source` condition pointing at `src/`.

### Static files in the package

The published package also ships three directories, served straight from a
static host:

| Path | Contents |
| --- | --- |
| `public-relay/relay.html`, `public-relay/relay-sw.js` | A ready relay: the iframe page (calls `getRelayWindowMessageHandler`) and a worker loader that `importScripts("../dist/relay-sw.js")`. `newRemoteRelayChannel()` points here by default. |
| `public/index.html`, `public/index.js`, `public/sw-worker.js` | Minimal same-origin demo, and a loader that `importScripts("../dist/sw-worker.js")`. |
| `demo/demo-1.html`, `demo/demo-2.html` | Relay demos: a Hono app (loaded from esm.sh) as an in-tab site, and a local folder served through the File System Access API. |

## Examples

Every example needs a real browser with ServiceWorker support. None runs under
Node.

### Relay mode: serve a handler from the page

```ts
import {
  callHttpService,
  initHttpService,
  newRemoteRelayChannel,
} from "@statewalker/webrun-http-browser";

// 1. Embed the hidden relay iframe and get a port into its worker.
const connection = await newRemoteRelayChannel({
  url: new URL("https://my-relay.example/relay.html"),
});

// 2. Register a handler for service "FS". Resolves a function that unregisters
//    it; that function's promise settles once the relay has dropped the service.
const unregister = await initHttpService(
  async (request) => new Response(`Hello ${new URL(request.url).pathname}`),
  { key: "FS", port: connection.port },
);

// 3. Call it through the same port, without going through `fetch`.
const res = await callHttpService(new Request("https://my-relay.example/~FS/anything"), {
  key: "FS",
  port: connection.port,
});
```

Any tab whose `fetch` reaches the relay worker for `https://my-relay.example/~FS/…`
is answered by this page's handler. `callHttpService` reaches the service over
the iframe's port instead, which is what a caller on another origin uses. It
rejects with `No service with key "FS"` when the worker refuses the
connection.

`newRemoteRelayChannel(options?)` takes `baseUrl` (default: the package's own
`public-relay/` directory, resolved from the module URL), `url` (default
`relay.html` under `baseUrl`) and `container` (default `document.body`). It
resolves `{ baseUrl, port, close() }`.

### Relay mode: mount services at paths

A service can claim a path prefix instead of `/~<key>/`. Several services can
share one relay connection:

```ts
await initHttpService(appHandler, { key: "app", path: "/", port: connection.port });
await initHttpService(meshHandler, { key: "mesh", path: "/peers/", port: connection.port });
```

The worker routes by the longest matching prefix, so a catch-all at `/` does
not shadow `/peers/`, and registration order does not matter. The matched
prefix is not stripped: a handler mounted at `/peers/` receives
`/peers/12D3Koo/llm`. A handler that routes relative to its mount strips the
prefix itself.

### Relay mode: WebSockets

The same handler accepts sockets: on a `GET` with `Upgrade: websocket` it
answers with `upgradeWebSocket` (see [WebSockets](#websockets)). A caller on
any origin opens one through the relay connection:

```ts
import { relayWebSocketClass } from "@statewalker/webrun-http-browser";

const WS = relayWebSocketClass({ key: "FS", port: connection.port });
const ws = new WS("https://my-relay.example/~FS/chat", ["v1"]);
ws.onmessage = (event) => console.log(event.data);
```

`callWebSocketService(url, protocols, { key, port })` is the lower level: it
resolves `{ port, protocol }` once the service accepted. The relay worker only
brokers the port; after that the socket runs between the caller and the
serving page directly. Content served on the relay origin itself opens sockets
through the relay worker with `serviceWorkerWebSocketClass()`, routed by its url
like a fetch. The relay's `canRegister` and `takeover` rules apply to sockets
as to requests, since both go to the service that holds the key.

### Relay mode: build your own relay worker

```ts
/// <reference lib="webworker" />
import { startRelayServiceWorker } from "@statewalker/webrun-http-browser/relay-worker";

declare const self: ServiceWorkerGlobalScope;

const stop = startRelayServiceWorker(self, {
  exclude: (url) =>
    url.pathname === "/index.html" ||
    url.pathname === "/relay.html" ||
    url.pathname === "/relay-sw.js",
  takeover: "first-wins",
  canRegister: (client, _key, path) =>
    new URL(client.url).pathname === "/relay.html" && path !== "/index.html",
  decorateResponse: (response) => response,
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `mounts` | none | Fixed table `Array<{ key, path?, match? }>`, for a host that knows its services at build time. A key declared here belongs to the host: a page's `REGISTER` or `UNREGISTER` for it never replaces or removes the mount, so the page can register with no `path`. |
| `exclude` | none | `(url) => boolean`. Paths the relay never claims, through the table or through `/~<key>/`. Checked first. |
| `canRegister` | everyone | `(client, key, path?) => boolean \| Promise<boolean>`. `path` is where the registrant asks to be mounted (`undefined` for `/~<key>/`), so a host can vet where a key lands, not only who takes it. Refuses with `this client may not register "<key>"` (`... at "<path>"`). Also consulted for `UNREGISTER`, with the key's current path. |
| `takeover` | `"last-wins"` | `"first-wins"` keeps a live holder's key; a second page gets `"<key>" is already served by another client`. A holder that reloaded is no longer live, so it can always re-register. |
| `decorateResponse` | none | `(response, request) => Response`. Stamps headers on responses the relay makes, including its error responses. Not applied to requests the worker leaves to the network. |
| `streamTimeout` | none | Per-stream inactivity timeout, in ms, of the links to services. |

`UNREGISTER` is accepted only from the client that holds the key, or, once
that client is gone, from any client `canRegister` allows: any page of the
relay origin can post to the worker, including foreign content the host serves
there.

`startRelayServiceWorker` returns a function that removes its listeners.

### Relay mode: options for the prebuilt worker

`dist/relay-sw.js` is an IIFE loaded with classic `importScripts`, which cannot
pass arguments. It reads its options from `self.RELAY_OPTIONS`, set by the
host's own worker script before the import:

```js
// relay-sw.js, served next to your relay page
self.RELAY_OPTIONS = {
  exclude: (url) =>
    url.pathname === "/index.html" ||
    url.pathname === "/relay.html" ||
    url.pathname === "/relay-sw.js",
  takeover: "first-wins",
};
importScripts("/path/to/@statewalker/webrun-http-browser/dist/relay-sw.js");
```

Without it the worker starts with `{}`. To type the object, import the type from
the typed subpath:

```ts
import type { RelayServiceWorkerOptions } from "@statewalker/webrun-http-browser/relay-worker";

declare const self: ServiceWorkerGlobalScope & { RELAY_OPTIONS?: RelayServiceWorkerOptions };
```

### Relay mode: the iframe page

`public-relay/relay.html` is this, and a self-hosted relay page looks the same:

```html
<script type="module">
  import { getRelayWindowMessageHandler } from "../dist/index.js";

  window.onmessage = getRelayWindowMessageHandler({
    swUrl: `${new URL("./relay-sw.js", import.meta.url)}`,
    scopeUrl: `${new URL("./", import.meta.url)}`,
  });
</script>
```

Without `swUrl` the handler registers the bundle's own `dist/relay-sw.js`,
and without `scopeUrl` the scope is that worker's directory, `dist/`: the
widest scope a script there may claim without a `Service-Worker-Allowed`
header. A relay page that serves services anywhere else passes both, as above.
`timeout` bounds the wait for the worker to activate. If the worker cannot start, every call the parent makes on the port
is answered with that error, so the parent's `initHttpService` /
`callHttpService` reject instead of hanging.

### Same-origin mode

```ts
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";

const KEY = "demo"; // also the first URL segment the worker routes here
const adapter = new SwHttpAdapter({
  key: KEY,
  serviceWorkerUrl: new URL("./sw-worker.js", import.meta.url).toString(),
});
await adapter.start();

const { baseUrl, remove } = await adapter.register(`${KEY}/api/`, async () =>
  Response.json({ now: Date.now() }),
);

const res = await fetch(`${baseUrl}anything`); // answered by the handler above
```

The worker script is a one-line loader served next to the app pages, so the
worker's default scope covers them:

```js
// sw-worker.js
importScripts("/path/to/@statewalker/webrun-http-browser/dist/sw-worker.js");
```

`SwHttpAdapter` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `key` | required | First URL segment under the scope that the worker routes to this page. |
| `serviceWorkerUrl` | `sw-worker.js` at the scope | Resolved against `location.href`. An unresolvable value throws `Invalid serviceWorkerUrl: "<value>" (relative to <href>)`. |
| `scope` | directory of `serviceWorkerUrl` | Registration scope. |
| `timeout` | `30_000` | Upper bound, in ms, for activation, control and the adapter's handshake. Past it `start()` rejects with a `ServiceWorkerControlError`. |
| `reloadIfUncontrolled` | `false` | Reload the page once instead of rejecting when it stays uncontrolled. |
| `streamTimeout` | none | Per-stream inactivity timeout of the links, in ms. Unset, a slow reader is throttled, never failed. |
| `id`, `meta` | a fresh id, none | The handler slot of this page's handlers, and what a `route` function sees of them. |
| `webSocket` | defaults | Options of `adapter.WebSocket` (`heartbeatMs`, `timers`, `closeTimeoutMs`). |

`register(prefix, handler)` resolves `{ baseUrl, prefix, remove() }`. The
prefix must start with the adapter's `key`.

### Same-origin mode: handlers in Dedicated Workers

A handler that does heavy work (SQLite on OPFS, WASM, a build) belongs in a
worker. Attached with `attachWorker`, the worker talks to the ServiceWorker
directly: the page makes the channels, hands one end of each to the worker and
the other to the ServiceWorker, and carries nothing afterwards, so a busy or
background-throttled page does not slow the requests down.

```ts
// page
const adapter = new SwHttpAdapter({ key: "app", serviceWorkerUrl: "/sw-worker.js" });
await adapter.start();
const worker = new Worker(new URL("./site-worker.js", import.meta.url), { type: "module" });
const link = await adapter.attachWorker(worker, { key: "site", id: "shard-0" });

// site-worker.js
import { serveHttpInWorker } from "@statewalker/webrun-http-browser/worker";

const service = serveHttpInWorker(async (request) => new Response("from a worker"));
// Requests through the ServiceWorker's router, to other handlers:
const other = await service.fetch("/app/api/x");
```

`attachWorker(worker, { key?, id?, meta? })` resolves a `WorkerLink`
`{ key, id, owner, drain({ ms }), detach() }`. Several workers may serve one key;
the ServiceWorker picks one per request (see below). Attaching an `id` the key
already has replaces that handler: the old one finishes its requests in flight
and gets no new ones.

`serveHttpInWorker(handler, options?)` returns `{ fetch, connectWebSocket,
WebSocket, linked, close() }`. Its `fetch` goes through the router without a
`fetch` event, so it works whether or not the worker is controlled.

### Same-origin mode: routing and hand-over

The ServiceWorker keeps a table of handlers per key and asks a `route`
function which one answers a request:

```js
// sw-worker.js, served next to your pages
self.HTTP_DISPATCHER_OPTIONS = {
  route: (request, key, handlers) =>
    handlers.find((h) => h.id === request.headers.get("x-shard")) ?? handlers[0],
};
importScripts("/path/to/@statewalker/webrun-http-browser/dist/sw-worker.js");
```

`handlers` are the live (not draining) handlers of the key, each a
`HandlerInfo` `{ id, key, owner, inflight, meta, attachedAt, draining }`. The
default, `leastInflightRoute`, takes the one with the fewest requests in flight,
the oldest on a tie: with one tab per key, the same page as before. A worker of
your own passes the options to `startHttpDispatcher({ self, ...options })`.

| Option | Default | What it does |
| --- | --- | --- |
| `route` | `leastInflightRoute` | Picks the handler. `undefined` makes the request wait for another to attach. |
| `attachTimeoutMs` | `15_000` | How long a request waits for a handler during a hand-over. Past it, `503`. |
| `relinkTimeoutMs` | `3_000` | How long a request waits for the pages to attach again after a restart. |
| `handoverMs` | `5_000` | How long a replaced handler may finish its requests. |
| `wsConnectTimeoutMs` | `15_000` | How long a socket waits for its handler's answer. |
| `streamTimeout` | none | Per-stream inactivity timeout of the links. |
| `livenessCheckMs` | `5_000` | Period of the backup liveness check (`navigator.locks.query()`); `0` turns it off. |

`link.drain({ ms })` hands a slot over: no new requests reach the handler (they
wait for the next owner of the key, up to `attachTimeoutMs`), and those in
flight may finish for up to `ms`. Then the link is closed. A drain or detach
names the attachment's `owner` token, so a late one from a previous owner never
touches the current one.

### Same-origin mode: restarts and liveness

The browser stops an idle ServiceWorker (Chromium after about 30 s), and every
port it held dies with it. Nothing reports that on the other end, so:

- **Re-linking.** The ServiceWorker keeps its table in memory only. The first
  request after a restart, for a key it served before, asks every window to
  attach its links again (`NEED_LINKS`) and waits for them. Pages answer by
  attaching their own handlers and their workers.
- **Handler liveness.** Each handler holds a Web Lock while it lives; the
  ServiceWorker watches it. When a tab closes or a worker is terminated, its
  requests in flight fail at once with `502` and
  `The handler was lost while this request was in flight; it may or may not
  have been applied.`
- **ServiceWorker liveness.** The ServiceWorker holds a Web Lock too, and the
  handlers watch it. When it dies, a worker's calls in flight over
  `service.fetch` fail with `LinkLostError` (`The ServiceWorker was lost while
  this call was in flight; ...`) instead of hanging, and new calls wait: the
  worker asks its page to attach it again, and that message wakes the
  ServiceWorker.
- **Keep-alive.** Port messages are not events, so a long call over
  `service.fetch` would not keep the ServiceWorker awake. While such calls are
  in flight, the worker asks its page every 20 s to post a keep-alive message
  to the ServiceWorker.

Without Web Locks, a page handler's liveness falls back to `clients.get()`, and
worker deaths are not noticed until a request times out.

### WebSockets

A ServiceWorker never sees WebSocket connections, so a socket is opened
explicitly and carried by a `MessagePort`. The handler side is an HTTP upgrade:

```ts
import { isWebSocketUpgrade, upgradeWebSocket } from "@statewalker/webrun-http-browser/worker";

async function handler(request: Request): Promise<Response> {
  if (isWebSocketUpgrade(request)) {
    const { socket, response } = upgradeWebSocket(request, { protocol: "v1" });
    socket.accept();
    socket.addEventListener("message", (event) => socket.send(event.data));
    return response; // status 101
  }
  return new Response("not a socket", { status: 426 });
}
```

The caller gets a class with the browser's `WebSocket` API, which leaves the
global `WebSocket` alone:

```ts
const ws = new adapter.WebSocket(`${baseUrl}chat`, ["v1"]);   // page with an adapter
const WS = serviceWorkerWebSocketClass();                     // any controlled page
const WS2 = service.WebSocket;                                // in a worker, via the router
```

The ServiceWorker only brokers the port: it routes the url like a fetch, asks
the handler, and hands the accepted port to the caller. The socket then runs
between the two directly, so it survives a ServiceWorker restart. A socket to
a handler in the same page needs no ServiceWorker at all.

- **Upgrade request.** A browser drops `Upgrade` and `Sec-*` headers from every
  `new Request()`, so the upgrade request carries them as its own `headers`
  property. `requestedProtocols(request)` reads the subprotocols.
- **Server end.** `ServerWebSocket` delivers events only after `accept()`
  (frames that arrive earlier are queued), answers pings before it, and has
  `send`, `close`, `bufferedAmount` and `whenDrained(limit)` for
  backpressure.
- **Client.** `createWebSocketClass(connect, options)` validates as the
  standard does (url, scheme, fragment, subprotocol tokens, close codes and
  reasons), has `binaryType`, the `on*` handlers and the close handshake.
  `bufferedAmount` is real: the other end acknowledges what it consumed.
- **Heartbeat.** A port never reports that its other side died. The client
  pings every `heartbeatMs` (default 10 s) and closes with 1006 when pongs stop
  for twice that; the server closes with 1006 when pings stop for three times
  that. On a page's main thread, pass unthrottled `timers`.
- **Wire protocol.** Frames `m` (message), `c` (close), `p`/`q` (ping/pong) and
  `a` (bytes consumed), version `WS_PORT_PROTOCOL_VERSION`; see
  `src/ws/frames.ts`.

### Same-origin mode: a page that is not controlled

```ts
try {
  await adapter.start();
} catch (error) {
  if ((error as Error).name === "ServiceWorkerControlError") showReloadPrompt();
  else throw error;
}
```

Check `name` or `reason`, not `instanceof`: each bundle carries its own copy of
the class. After a failure, calling `start()` again retries.

### Running the bundled examples

```sh
pnpm run example:same-origin   # build, serve on :5173, open public/index.html
pnpm run example:relay-site    # build, serve on :5173, open demo/demo-1.html
pnpm run example:relay-files   # build, serve on :5173, open demo/demo-2.html
pnpm run serve                 # static server on :5173, no build, no browser
```

Open them through `http://localhost:5173/…`; ServiceWorkers do not register
from `file://`. The relay demos fetch their service through
`<relay-base>/~KEY/` URLs under `public-relay/`, which the relay worker
does not claim; see
[`/~<key>/` is recognised only at the origin root](#key-is-recognised-only-at-the-origin-root).

## Internals

### How a request travels

Relay mode:

```
caller tab                     relay origin                                  serving page
fetch(<relay>/~KEY/x) ──► relay worker ── CONNECT(key) ──► relay iframe ──port──► initHttpService handler
                          (mount table,       │                                          │
                           IndexedDB)         └──────── MessagePort per call ◄───────────┘
callHttpService(req, {key, port}) ──port──► relay iframe ──► relay worker ──► same path
```

Same-origin mode:

```
page fetch(<scope>/KEY/...) ──► same-origin worker ── KEY = first path segment
                                 route(request, KEY, handlers) ──down──► page handler (SwHttpAdapter.register)
                                                               ──down──► worker handler (serveHttpInWorker)
worker service.fetch(url)  ──up──► same-origin worker ── same routing
new WebSocket(...)         ──WS_CONNECT──► same-origin worker ──ctl──► handler ── port ──► caller
```

Every link is one `MessagePort` (`down`: requests a handler serves; `up`:
requests a worker sends; `ctl`: socket hand-over). Calls on a link are
multiplexed by `@statewalker/webrun-rpc` (`connect` / `serve` over `overPipe`),
each a stream with a one-chunk window in both directions, and HTTP runs over
them with `fetchOverDuplex` / `serveFetchOverDuplex` from
`@statewalker/webrun-http-streams`. The relay uses the same links, one per
`CONNECT`. Every hand-shake carries `HTTP_LINK_PROTOCOL`: a peer of version 1
(this package's own stream transport) is still served over that transport, and
a page whose worker runs an older version gets a `ServiceWorkerControlError`
with `reason: "incompatible"`.

### Every bundle is self-contained

This package does not externalise its dependencies. Its own HTML loads
`../dist/index.js` from a static host with no import map, and the two IIFE
workers are loaded with `importScripts`, which cannot resolve a bare
specifier. So each of the six outputs is one file with `idb-keyval`,
`@statewalker/webrun-streams` and `@statewalker/webrun-http-streams` inlined,
built from its own rolldown config so no chunks are shared. The cost is
duplicated code across bundles, and that `instanceof` does not hold across this
package's boundary.

The workers are IIFE rather than module workers so a classic `importScripts`
loader can pull them in. The relay page registers its worker with no `type`.

Page-side defaults resolve against a `moduleUrl` variable instead of a literal
`new URL("…", import.meta.url)`. Bundlers such as Vite rewrite the literal form
into an emitted asset at build time, which made consumers ship a dead copy of
`dist/index.js`.

### Relay routing: a request that is nobody's goes to the network

For each `fetch` the relay worker decides, in this order:

1. Another origin: not the relay's.
2. `exclude(url)` is true: not the relay's.
3. The longest matching mount prefix, then `match` predicates in registration
   order.
4. The `/~<key>/` spelling.

A request that matches nothing is not answered at all: the worker does not call
`respondWith`, so the browser performs it as if no worker were installed. That
is what lets a host serve its own files from the relay origin, and it is why a
root mount needs `exclude`.

A root mount claims every path under the scope, including the host's own
navigation. `exclude` needs three entries: the relay page, the worker script,
and the host's own entry page. Miss the third and nothing fails until the first
reload, which then requests the entry page through the mount and cannot get
back.

Mounts live in memory and registrations in IndexedDB, so a restarted worker
reads the registrations back before routing. Requests that arrive before that
read settles are claimed and, if nobody's, re-issued with `fetch(request)`.
After it settles the decision is synchronous again, which keeps navigation
preload and `cache: "only-if-cached"` working. A failed restore is logged
(`[relay] failed to restore mounts from the registry`) and routing continues
with whatever the table holds.

### `/~<key>/` is recognised only at the origin root

`splitServiceUrl` is anchored to the start of the pathname:
`https://host/~FS/a/b` yields key `FS`, while
`http://localhost:5173/public-relay/~FS/a` yields no key. So a relay worker
whose scope is a subdirectory, like the shipped `public-relay/`, does not claim
`fetch()` calls to `<scope>/~<key>/…`; they go to the network. `callHttpService`
still works there, since it does not depend on URL routing, and so does a
service registered with a `path` inside the scope. Query strings and fragments
are ignored, so `?q=~foo` is never read as a service.

### Who may register a key

The default `takeover: "last-wins"` lets the last page that registers a key
take it. With mounts, a rogue or buggy same-origin page could then claim the
origin root, and the registration persists in IndexedDB across page loads and
worker restarts. On any origin where more than the host's own page can reach
the relay, set `takeover: "first-wins"` and `canRegister` together for a mount
at `/`.

A `CONNECT` is delivered only to the service named by its key. Services on one
port that are not the addressee stay silent; a reply of `false` would reach the
worker first and turn into a 403.

### Relay error responses

When the relay worker cannot hand a request to a service, it answers with JSON
(`{ status, statusText, message, url, key, baseUrl, path }`):

| Cause | Status |
| --- | --- |
| No live client for the key (the page closed) | `410`, `Error 410: Resource Gone` |
| The page refused the connection | `403`, `Error 403: Forbidden` |
| Anything else thrown | `500`, with `statusText` `Bad Request` (from `HttpError.fromError`) |

### Same-origin routing

The worker takes the first path segment under its scope as the key and routes
the request to one of the key's handlers. A key that was served at some point
but has no live handler answers `404 Not Found (no active handler)` rather
than falling through to the network: a dev server's SPA fallback would
otherwise serve the app shell for every site URL. (After a restart, the first
such request first asks the pages to link again; see above.) A URL outside the
scope, or of a key never served, is not answered at all: the worker does not
call `respondWith`, so the browser performs the request as without a worker. On
the page, a request matching no registered prefix gets
`404 Error 404: Not found`.

The worker keeps only the served keys in IndexedDB (`claimedKeys`); the
handlers are attached again after a restart. The relay keeps its registry
under `clientsIds` as `{ clientId, path }` entries and still reads the older
bare-client-id shape.

`SwPortHandler.stop()` unregisters only the registration its own `start()`
made; other workers on the origin stay registered. After a `start()` that
rejected, `stop()` unregisters nothing, since that attempt kept the worker.

### A page can load uncontrolled although its worker is active

A hard reload (Ctrl+Shift+R / Cmd+Shift+R) bypasses ServiceWorkers for that
load, and the worker's `clients.claim()` already ran at activation, so nothing
hands the page to it. Firefox has also left a second page of a running worker
uncontrolled.

Same-origin mode needs control, because only a controlled page's `fetch()`
reaches the worker. `awaitServiceWorkerControl` (used by `SwHttpAdapter.start()`)
sends a `CLAIM` call, which this package's workers answer with
`clients.claim()`, and waits for `controllerchange` plus a 1 s grace period.
If control still does not come it rejects with `ServiceWorkerControlError`,
`reason: "uncontrolled"`, and a message that starts
`This page is not controlled by its ServiceWorker …`. With
`reloadIfUncontrolled: true` it reloads once instead; a `sessionStorage`
marker makes a second uncontrolled load reject rather than loop. A worker of
your own should call `handleClaimRequests(self)`.

Relay mode needs only a worker to message, so an uncontrolled relay page
bridges to `registration.active`. A page excluded from a root mount is not
answered by the worker and can load uncontrolled in Firefox; call
`awaitServiceWorkerControl(registration)` before relying on its `fetch()`.

`ServiceWorkerControlError.reason` is one of:

- `activation-timeout`: the worker did not activate within `timeout`
  (`ServiceWorker "<url>" (scope <scope>) did not activate within <n> ms …`);
- `uncontrolled`: active, but the page is not controlled;
- `unresponsive`: controls the page but did not answer the adapter's
  `UPDATE_COMMUNICATION_PORT` handshake in time;
- `incompatible`: answered the handshake but runs an older version of this
  package (reload the page once the updated worker is active).

### Backpressure, and where the browser buffers

Both modes move requests over webrun-rpc links: a handler producing a body is
never more than a few chunks ahead of whoever reads it through this package's
links, and a reader that stops (an aborted `fetch`, a cancelled body) releases
the producer. Between a ServiceWorker's `respondWith` and the page, though,
Chromium buffers by itself, tens of megabytes of a fast stream: a page reading
slowly sees the handler run that far ahead before backpressure reaches it
(about 55 MiB, the same for a plain ServiceWorker with no library). A worker
reading through `service.fetch` has no such buffer. `links.browser.ts` pins
the split: once a page stops reading, the handler is never more than a few
chunks ahead of what the ServiceWorker handed to Chromium, and stops.

`sendStream` / `handleStreams`, and the `sendHttpRequest` /
`handleHttpRequests` pair built on them, are version 1's transport, kept for
peers that still speak it. They have no backpressure (a fast producer over a
slow consumer accumulates without bound), no per-stream timeout and no
chunking, and are `@deprecated`.

### The adapter's default worker url follows the scope

Without `serviceWorkerUrl`, `SwPortHandler` (and so `SwHttpAdapter`) uses
`sw-worker.js` at its scope, the scope resolved against the bundle's url. With
`scope: "/dist/"` that is the shipped `dist/sw-worker.js`; with `scope: "/"` it
is `/sw-worker.js`, a loader the host must serve there. Constructing a
`SwHttpAdapter` with neither `serviceWorkerUrl` nor `scope` fails with
`RangeError: Maximum call stack size exceeded`, because each default is
computed from the other.

### Constraints

- **Firefox buffers request bodies.** Firefox has no `Request.prototype.body`,
  so the stubs read the whole request body into memory on both sides. Response
  streaming is unaffected.
- **Scope rules apply.** A worker at `/public/sw-worker.js` controls only
  `/public/`. A wider scope needs the `Service-Worker-Allowed` header, or the
  script must live higher up.
- **Relay mode needs an iframe.** A page whose CSP blocks `frame-src` to the
  relay origin cannot use it.
- **Plain `fetch()` works only from pages under the worker's scope.** A caller
  on another origin uses `callHttpService`.
- **`Set-Cookie` does not reach a page through a ServiceWorker.** A
  browser-built `Response` drops it; carry state another way.
- **Liveness needs Web Locks** (`navigator.locks`, in every current browser).
  Without it, handler deaths are noticed late and ServiceWorker deaths not at
  all.

### Exports of the root entry

Relay, page side:

| Export | Purpose |
| --- | --- |
| `newRemoteRelayChannel(opts?)` / `RemoteRelayChannel`, `RemoteRelayChannelOptions` | Embed the relay iframe; resolves `{ baseUrl, port, close() }`. |
| `initHttpService(handler, { key, path?, port, streamTimeout? })` | Register a service (HTTP and sockets); resolves a function that unregisters it, whose promise settles once the relay acknowledged. |
| `callHttpService(request, { key, port })` | Call a service through the port. |
| `callWebSocketService(url, protocols, { key, port })` / `relayWebSocketClass({ key, port }, options?)` | Open a socket to a service through the port. |
| `answerConnect(handler, data, port)`, `sendOverConnection(port, reply, request)` | The two ends of one `CONNECT`, for a host with its own registration. |
| `ServiceOptions`, `ConnectReply`, `WebSocketConnectParams` | `{ key, path?, port, streamTimeout? }`, and the `CONNECT` shapes. |
| `getRelayWindowMessageHandler(opts?)` / `RelayWindowHandlerOptions` | The relay iframe's `window.onmessage`; options `swUrl`, `scopeUrl`, `timeout`. |
| `initializeConnection(opts)` / `InitializeConnectionOptions` | Send `CONNECT` for a key; resolves a `MessagePort`, or `null` if refused. Extra fields ride in the payload. |
| `registerConnectionsHandler(opts)` / `RegisterConnectionsHandlerOptions` | Register a key (and optional `path`) and answer its `CONNECT`s; resolves an awaitable cleanup. |
| `splitServiceUrl(url, separator = "~")` / `SplitServiceUrl` | Parse `<origin>/~<key>/<path>` into `{ url, key, baseUrl, path }`. |

ServiceWorker lifecycle:

| Export | Purpose |
| --- | --- |
| `initServiceWorker({ swUrl, scopeUrl?, type?, timeout? })` / `InitServiceWorkerOptions` | Register a worker; resolves the controller, or the active worker if the page is not controlled. |
| `newServiceWorkerPort(registration?)` | A `MessagePort` bridged to the controller, or to `registration.active`. |
| `awaitActiveServiceWorker(registration, { timeout? })` | Resolves once `activated`. |
| `awaitServiceWorkerControl(registration, { timeout?, reloadIfUncontrolled? })` | Resolves once the page is controlled, asking the worker to claim it. |
| `handleClaimRequests(self)` | Worker side: answer `CLAIM` with `clients.claim()`. |
| `ServiceWorkerControlError`, `ServiceWorkerControlFailure` | Error class and its `reason` union. |
| `AwaitServiceWorkerOptions`, `AwaitServiceWorkerControlOptions` | Option types. |
| `DEFAULT_SERVICE_WORKER_TIMEOUT`, `CLAIM_CALL` | `30_000`, `"CLAIM"`. |

Messaging primitives:

| Export | Purpose |
| --- | --- |
| `callChannel(target, type, params, ...transfers)` / `handleChannelCalls(target, type, handler)` / `ChannelCallHandler` | One typed request/response over a `MessageTarget`; errors travel serialised. |
| `newInvokationChannel(opts)` / `InvocationChannel`, `NewInvocationChannelOptions` | Numbered invocations over one target. |
| `sendStream(port, input, params?)` / `handleStreams(port, handler)` / `StreamHandler` | Stream-shaped calls, one `MessageChannel` each. No backpressure. |
| `sendHttpRequest(port, request)` / `handleHttpRequests(port, handler)` | Deprecated. HTTP over the stream calls. |
| `newRegistry(onError?)` / `Registry`, `NewRegistryResult`, `CleanupAction` | Cleanup registry. |
| `MessageTarget`, `MessageSource`, `MessageSink`, `MessageListener` | Port view types, re-exported from `@statewalker/webrun-rpc`. |

Same-origin, links and WebSockets (also on `./sw`):

| Export | Purpose |
| --- | --- |
| `SwHttpAdapter`, `SwHttpAdapterOptions`, `SwHttpRegistration`, `AttachWorkerOptions`, `WorkerLink` | The page side. |
| `SwHttpDispatcher`, `startHttpDispatcher`, `SwHttpDispatcherOptions` | The ServiceWorker side. |
| `HandlerTable`, `HandlerInfo`, `RouteFunction`, `leastInflightRoute` | Routing. |
| `serveHttpInWorker`, `WorkerHttpService`, `HandlerEndpoint` | The handler side (also on `./worker`). |
| `connectHttpLink`, `serveHttpLink`, `trackedLink`, `HttpLink`, `LinkLostError`, `HTTP_LINK_PROTOCOL` | HTTP over one `MessagePort`. |
| `holdLock`, `watchLock`, `newLockName`, `locksAvailable`, `PortRendezvous` | Liveness and reply-matching helpers. |
| `createWebSocketClass`, `PortWebSocket`, `WebSocketConnector`, `WebSocketConnection` | The client. |
| `upgradeWebSocket`, `ServerWebSocket`, `takePort`, `takeUpgrade`, `serveWebSocketUpgrade`, `newWebSocketUpgradeRequest`, `isWebSocketUpgrade`, `requestedProtocols`, `withHeaders` | The server end and the upgrade. |
| `serviceWorkerWebSocketClass`, `connectWebSocketThroughServiceWorker` | Sockets from any page a ServiceWorker of this package controls. |
| `SwPortHandler`, `SwPortDispatcher` | Version 1's bases, kept for subclasses. |

The root entry also re-exports all of `@statewalker/webrun-streams` and
`@statewalker/webrun-http-streams`.

### Dependencies

All four runtime dependencies are bundled into `dist/`:

- `@statewalker/webrun-rpc`: the link transport (`connect` / `serve` over
  `overPipe`), and the `MessageTarget` types.
- `@statewalker/webrun-http-streams`: HTTP over those streams
  (`fetchOverDuplex` / `serveFetchOverDuplex`), version 1's stubs, and
  `HttpError`.
- `@statewalker/webrun-streams`: iterator helpers and error serialisation.
- `idb-keyval`: a small IndexedDB key-value store that keeps registrations
  across worker restarts.

### Tests

- `pnpm test`: unit tests under Node, against the source.
- `pnpm run test:browser`: builds, then runs `tests/browser/` in Chromium and
  Firefox through Playwright against the built bundles, plus
  `tests/packaging/`, which checks the published exports map. Needs the
  browsers: `pnpm exec playwright install chromium firefox`. `links.browser.ts`
  (workers, routing, restarts, sockets) and `relay-links.browser.ts` run in
  Chromium only: they stop the ServiceWorker through CDP and use two origins.

## License

MIT
