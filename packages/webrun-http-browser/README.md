# @statewalker/webrun-http-browser

## What it is

A ServiceWorker-based HTTP server for the browser. You write ordinary
`(Request) => Response` handlers in page JavaScript; a ServiceWorker intercepts
`fetch()` calls and routes them to those handlers over a `MessagePort`, with no
network round-trip and no external server. It has two modes:

- **Same-origin** (`./sw` + `./sw-worker`): your app registers its own worker
  next to its pages and mounts handlers under URL prefixes.
- **Relay** (`.` + `./relay-sw` or `./relay-worker`): a worker hosted on a relay
  origin serves requests for any page that embeds a hidden relay iframe. The
  page never registers a worker of its own.

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
| `.` | ESM, `dist/index.js` + `.d.ts` | page, relay iframe | Relay page API (`newRemoteRelayChannel`, `initHttpService`, `callHttpService`, `getRelayWindowMessageHandler`, `splitServiceUrl`), ServiceWorker lifecycle helpers (`initServiceWorker`, `newServiceWorkerPort`, `awaitActiveServiceWorker`, `awaitServiceWorkerControl`, `handleClaimRequests`, `ServiceWorkerControlError`), the `MessagePort` call primitives, and everything re-exported from `@statewalker/webrun-streams` and `@statewalker/webrun-http-streams`. |
| `./sw` | ESM, `dist/sw.js` + `.d.ts` | page and worker | Same-origin classes: `SwHttpAdapter` (page), `SwHttpDispatcher` and `startHttpDispatcher` (worker), and their bases `SwPortHandler` / `SwPortDispatcher`. |
| `./sw-worker` | IIFE, `dist/sw-worker.js`, no types | ServiceWorker | Prebuilt same-origin worker: calls `startHttpDispatcher({ self, log: console.log })`. Load it with `importScripts`. |
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

// 2. Register a handler for service "FS". Returns a cleanup that unregisters it.
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
  canRegister: (client, _key) => new URL(client.url).pathname === "/relay.html",
  decorateResponse: (response) => response,
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `mounts` | none | Fixed table `Array<{ key, path?, match? }>`, for a host that knows its services at build time. A key declared here belongs to the host: a page's `REGISTER` or `UNREGISTER` for it never replaces or removes the mount, so the page can register with no `path`. |
| `exclude` | none | `(url) => boolean`. Paths the relay never claims, through the table or through `/~<key>/`. Checked first. |
| `canRegister` | everyone | `(client, key) => boolean \| Promise<boolean>`. Refuses a registration with `this client may not register "<key>"`. |
| `takeover` | `"last-wins"` | `"first-wins"` keeps a live holder's key; a second page gets `"<key>" is already served by another client`. A holder that reloaded is no longer live, so it can always re-register. |
| `decorateResponse` | none | `(response, request) => Response`. Stamps headers on responses the relay makes, including its error responses. Not applied to requests the worker leaves to the network. |

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

Pass `swUrl` explicitly. Its default is `index-sw.js` next to the module, a
file the build does not produce. `timeout` bounds the wait for the worker to
activate. If the worker cannot start, every call the parent makes on the port
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
| `serviceWorkerUrl` | none; pass it | Resolved against `location.href`. An unresolvable value throws `Invalid serviceWorkerUrl: "<value>" (relative to <href>)`. |
| `scope` | directory of `serviceWorkerUrl` | Registration scope. |
| `timeout` | `30_000` | Upper bound, in ms, for activation, control and the adapter's handshake. Past it `start()` rejects with a `ServiceWorkerControlError`. |
| `reloadIfUncontrolled` | `false` | Reload the page once instead of rejecting when it stays uncontrolled. |

`register(prefix, handler)` resolves `{ baseUrl, prefix, remove() }`. The
prefix must start with the adapter's `key`.

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
page fetch(<scope>/KEY/...) ──► same-origin worker ── first path segment = KEY ──► page's port
                                                                                 └► SwHttpAdapter
                                                                                    (first registered prefix that matches)
```

Each call opens its own `MessageChannel`. The request is turned into a
`SerializedHttpEnvelope` by `newHttpClientStub` and rebuilt on the other side
by `newHttpServerStub` (both from `@statewalker/webrun-http-streams`), with the
body streamed as chunks over the port.

### Every bundle is self-contained

This package does not externalise its dependencies. Its own HTML loads
`../dist/index.js` from a static host with no import map, and the two IIFE
workers are loaded with `importScripts`, which cannot resolve a bare
specifier. So each of the five outputs is one file with `idb-keyval`,
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

The worker takes the first path segment under its scope as the key and forwards
the request to the page that registered it. A key that was registered at some
point but has no live page answers `404 Not Found (no active handler)` rather
than falling through to the network: a dev server's SPA fallback would
otherwise serve the app shell for every site URL. Any other URL is passed
through with `fetch(event.request)` unchanged; rebuilding the request would
drop `mode`, and the constructor throws for `only-if-cached` navigations. On the
page, a request matching no registered prefix gets `404 Error 404: Not found`.

The worker keeps the claimed keys and client ids in IndexedDB (`claimedKeys`,
`clientIds`) and asks each known client for a fresh port when it restarts. The
relay keeps its registry under `clientsIds` as `{ clientId, path }` entries and
still reads the older bare-client-id shape.

`SwPortHandler.stop()` unregisters every ServiceWorker registration of the
origin, not only its own.

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
  `UPDATE_COMMUNICATION_PORT` handshake in time.

### The port transport has no backpressure

`sendStream` / `handleStreams`, and the `sendHttpRequest` /
`handleHttpRequests` pair built on them, discard the promise their chunk
sender returns, so a fast producer over a slow consumer accumulates without
bound. There is also no per-stream timeout and no chunking to a transport's
message size limit. `sendHttpRequest` and `handleHttpRequests` are marked
`@deprecated` in favour of `duplexOverPort` / `serveDuplexOverPort` from
`@statewalker/webrun-rpc` with `httpFetch` / `httpServe` from
`@statewalker/webrun-http-streams`, which do have backpressure. Both modes of
this package still use the deprecated pair internally. A caller that stops
reading early does tell the peer to stop producing.

### Defaults that point at a file the build does not produce

`getRelayWindowMessageHandler`'s default `swUrl` and `SwPortHandler`'s default
worker URL both resolve to `index-sw.js` next to the module. No such file is
built. Pass `swUrl` / `serviceWorkerUrl` explicitly. Constructing a
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

### Exports of the root entry

Relay, page side:

| Export | Purpose |
| --- | --- |
| `newRemoteRelayChannel(opts?)` / `RemoteRelayChannel`, `RemoteRelayChannelOptions` | Embed the relay iframe; resolves `{ baseUrl, port, close() }`. |
| `initHttpService(handler, { key, path?, port })` | Register a service; resolves a cleanup that unregisters it. |
| `callHttpService(request, { key, port })` | Call a service through the port. |
| `ServiceOptions` | `{ key, path?, port }`. |
| `getRelayWindowMessageHandler(opts?)` / `RelayWindowHandlerOptions` | The relay iframe's `window.onmessage`; options `swUrl`, `scopeUrl`, `timeout`. |
| `initializeConnection(opts)` / `InitializeConnectionOptions` | Send `CONNECT` for a key; resolves a `MessagePort`, or `null` if refused. Extra fields ride in the payload. |
| `registerConnectionsHandler(opts)` / `RegisterConnectionsHandlerOptions` | Register a key (and optional `path`) and answer its `CONNECT`s; resolves a cleanup. |
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

The root entry also re-exports all of `@statewalker/webrun-streams` and
`@statewalker/webrun-http-streams`.

### Dependencies

All four runtime dependencies are bundled into `dist/`:

- `@statewalker/webrun-http-streams`: the client/server stubs the port
  transport is built on, and `HttpError`.
- `@statewalker/webrun-streams`: iterator helpers and error serialisation.
- `@statewalker/webrun-rpc`: only the `MessageTarget` types.
- `idb-keyval`: a small IndexedDB key-value store that keeps registrations
  across worker restarts.

### Tests

- `pnpm test`: unit tests under Node, against the source.
- `pnpm run test:browser`: builds, then runs `tests/browser/` in Chromium and
  Firefox through Playwright against the built bundles, plus
  `tests/packaging/`, which checks the published exports map. Needs the
  browsers: `pnpm exec playwright install chromium firefox`.

## License

MIT
