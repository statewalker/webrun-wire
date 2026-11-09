# @statewalker/webrun-http-browser

## 0.12.4

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-http-streams ^0.4.1 -> ^0.4.2
  - @statewalker/webrun-rpc ^0.10.1 -> ^0.10.2

## 0.12.3

### Patch Changes

- 3bb1254: A response body read over an HTTP link no longer keeps memory per chunk. Each read raced the reader against a promise for the link's loss, which never settles while the link lives, so every chunk left a reaction on it until the body ended: a 200,000 × 16 B body grew the heap by about 88 MB. A read now waits on the reader alone, and closing the link fails the body directly. The body still fails with the link's reason when the link closes, and an abort of the request's signal still ends it at once. One difference shows: chunks already buffered in the body when the link closes are dropped (up to about a flow-control window of data that had arrived), and the next read fails at once with the link's reason, as an abort does. A body cancelled just after its last chunk still leaves the handler the rest of the upload: the cancel reaches the body a macrotask later, once its read in flight has started, so that read decides whatever the engine's microtask timing.
- 1e8e15d: An abort of a request's signal reaches its response body even after the caller has let the `Request` go. In Node, a `Request`'s signal follows the caller's signal only while the `Request` lives (undici holds the Request's controller through a WeakRef), so a caller that kept only the `Response` could abort, and the body (from `fetchOverDuplex`, or an HTTP link's `send`) never saw it: the read went on, and the call, its port and the link's `inflight` stayed taken. The response body now holds its `Request` until it ends, and lets it go then; a call that is finished but not yet ended by the peer holds it until the call ends, so an abort can still abandon it (`HttpDataOptions.keepAlive`, which `fetchOverDuplex` sets). `WorkerHttpService.fetch(request, init)` passes the request's signal on explicitly.
- Updated dependencies [3bb1254]
- Updated dependencies [1e8e15d]
  - @statewalker/webrun-rpc@0.10.1
  - @statewalker/webrun-http-streams@0.4.1

## 0.12.2

### Patch Changes

- 70ad79d: A socket measures each message's UTF-8 size natively (`TextEncoder.encodeInto` into a reused buffer) instead of in a JavaScript loop over its characters. Both ends measure every message, for `bufferedAmount` and for the byte acknowledgements, and the loop took about 0.26 ms per 64 KiB string: an echo of 64 KiB messages spent about 1 ms per message counting bytes. Through cellb (a WebSocket into a loaded Worker, on Node), 64 KiB messages go from 72 to about 200 MB/s and 1 KiB messages from about 23,000 to 30,000 per second. The counts are the same as before, a lone surrogate counting as the 3 bytes of U+FFFD.

## 0.12.1

### Patch Changes

- d7d8229: The same-origin dispatcher serves hosts that route by their own rules:
  
  - A request whose `route` declines every handler of its key, because it waits for one in particular such as a shard, now waits for attaches until `route` accepts one, up to `attachTimeoutMs`. The time a relink round takes counts against that. Before, the next attach of any handler ended the wait with a 503. After a relink round that brought back handlers `route` declined, it gave a 404. Now it waits, and answers `"timeout"` (503) past the deadline. A key with no handler back at all still answers `"gone"` (404).
  - `failure(request, { kind, error })` answers the dispatcher's own failures, `"timeout"`, `"gone"` and `"lost"`, in the host's shape. `"lost"` covers every failed send, its `error` being a `LinkLostError` when the handler was lost. If the hook throws, the default answers. The defaults are unchanged: 503, 404 and a plain-text 502.
  - `socketHeaders(headers, from)` filters what a socket's upgrade carries, by whether a page or a handler asked for it. A host drops from pages' sockets the headers only its handlers may send. `from` is the path the socket came by, not a trust boundary: any page of the origin can attach a handler.
  - `dispatcher.ready` settles once the keys served before a restart are read back.
  - `webSocketUpgradeResponse(port, protocol)` is the 101 for a socket whose server end the handler runs itself.
- de7c7fb: The declarations compile with the DOM lib alone. The ServiceWorker-facing API (`SwHttpDispatcher`'s and `SwPortDispatcher`'s `self`, `handleFetch(event)`, `handleClaimRequests(self)`, and `relay-worker`'s `startRelayServiceWorker(self)` with its `canRegister(client)`) named `ServiceWorkerGlobalScope` and `FetchEvent`, which only TypeScript's WebWorker lib has. Every consumer that imported a type from `sw` or the main entry then failed to compile without that lib, unless it skipped lib checks. These now take a `ServiceWorkerScope`, a `FetchEventLike` and a `ServiceWorkerClientLike`, all exported: structural types that a ServiceWorker's `self` and its `fetch` events satisfy. `dispatcher.self` is typed as `ServiceWorkerScope` too. Code that used `dispatcher.self` for WebWorker members (`self.clients.claim()`) casts it, or keeps its own reference to the global `self`.
- 21d2d7f: `ServerWebSocket`, through `upgradeWebSocket`'s options, carries what other platforms' server ends need. workerd's `WebSocketPair` can be built on it:
  
  - `heartbeatPeriod: "first"` keeps the first ping's period. A page announces a longer one when it turns hidden, and a closing tab turns hidden on its way out.
  - `sendBeforeAccept` lets `send()` before `accept()`.
  - `deliverWhileClosing` delivers the messages that were in flight when `close()` was called.
  - `defaultCloseCode` is the code `close()` sends when given none, for example 1005.
  - `closeTimeoutMs: Infinity` waits for the close echo for as long as it takes. A timer given Infinity used to fire at once.
  - `binaryType` can be `"blob"`.
  - A subclass can override `checkClose(code, reason)` with its platform's close rules.
  - `detach()` hands an unaccepted end's port to another holder, with the frames that reached it delivered first. Acks the end was still owed are absorbed on the way.
  
  A ping announcing a period no timer takes (2³¹−1 ms or more, a client that turned its heartbeat off) stops the heartbeat watch rather than arming one that would fire every millisecond.

## 0.12.0

### Minor Changes

- 3fc3ec8: The HTTP link pipelines its bodies. `HttpLinkOptions.window` (bytes, default 256 KiB) is the flow-control window the calling end asks each request's port for; under it, request and response bodies stream without a confirmation per chunk, and a reader that stops holds about one window of its body per direction, per hop: N stalled requests on one link hold about N × the window, up to `maxPorts` (by default 1024 × 256 KiB), so memory grows with the number of stalled downloads. `window: 0` turns it off and puts exactly the previous envelopes on the wire. The ServiceWorkers' own links take it too (`SwHttpDispatcherOptions.window`, `RelayServiceWorkerOptions.window`), and `callHttpService` passes its options' `window` on. An answering end of an older version falls back to confirmed chunks by itself; `HTTP_LINK_PROTOCOL` is unchanged.

### Patch Changes

- 5308105: A host's ServiceWorker can take over `fetch` handling from the same-origin dispatcher. With `handleFetch: false` on a dispatcher the host constructs, it adds no `fetch` listener. The host's own listener answers its routes and passes the rest to the new `dispatcher.handleFetch(event, request?)`, which can take a rewritten request (cookies the host adds, say). `handleFetch` returns whether it called `respondWith`. A new `unserved(request)` option answers a navigation under the scope whose key nobody serves, including one taken before the stored keys are read after a restart. It defaults to the network, as before, so a host can give its own page for urls no tab serves. Other requests nobody serves still go to the network. `startHttpDispatcher` refuses `handleFetch: false`, since nothing could call `handleFetch` then.
- 530a6bc: The same-origin dispatcher takes a `key` option, `(url, scope) => key | undefined`, which decides the key a url belongs to for `dispatch()` (and so a handler's `service.fetch`), for sockets, and for `fetch` events of this origin's urls. The default, now exported as `scopeKey`, is the first path segment under the scope, as before. A host with another layout gives its own: a site at the origin's root, or projects under a base path. A key for another origin's url, such as an internal host its handlers call each other on, serves handlers' `service.fetch` and sockets. Those used to go to the network, because a url outside the scope had no key. A page's own `fetch` to that origin stays the browser's. `scopeKey` gives no key for a segment that does not decode, rather than throwing.
- 4446b95: `SwHttpAdapter` takes a `type` option and a `registration` option. `type: "module"` registers an ES-module worker, one that imports `startHttpDispatcher` from `sw.js`. Before, the adapter always registered the worker as a classic one, so a module worker failed to start. `registration` hands the adapter a registration the page made itself, with its own script, scope or type. The adapter then registers nothing, takes its scope from that registration, and `stop()` leaves the registration in place. The ServiceWorker side now routes under its registration's scope rather than its script's folder. A worker registered with another scope (`register(url, { scope })`) read the wrong key from every url, so its handlers answered 404.
- b9c2517: `connectWebSocket` takes headers as a third argument (`HeadersInit`), on a page's `SwHttpAdapter` and on a worker's `serveHttpInWorker` service. The handler sees them on the upgrade request, and so does a `route` function choosing it. A worker's socket to another handler (`ws-open`) used to carry only its url and subprotocols, so a host could not route it by anything else, a shard for instance. The headers are the caller's word, and an older ServiceWorker drops them. A caller's `sec-websocket-protocol` header no longer reaches the upgrade request: `protocols` alone names the subprotocols asked for.
- 7535931: `ServerWebSocket` (and `upgradeWebSocket`) take `watch: "first-ping"`: the heartbeat watch starts with the client's first ping instead of at once. A peer that never pings, such as the other end of a pair kept in the same realm, is then never closed with 1006 for its silence. Once pings have started, a socket whose pings stop still closes. The default, `"open"`, keeps today's behaviour.
- Updated dependencies [c95cc50]
  - @statewalker/webrun-rpc@0.10.0

## 0.11.0

### Minor Changes

- Release of the changes since the last published version:
  
  - files changed: dist/index.js, dist/relay-sw.js, dist/relay-worker.js, dist/sw-worker.js, dist/sw.js, 1 more
  - @statewalker/webrun-rpc crosses a breaking line

### Patch Changes

- Updated dependencies [4e88f7b]
  - @statewalker/webrun-rpc@0.9.0

## 0.10.0

### Minor Changes

- cf94377: A `Request` served by `serveHttpLink` now has a `signal` that aborts when the caller leaves before the exchange is over, so a long-polling handler can stop waiting. The self-contained `sw-worker.js` bundle carries it; `relay-sw.js` serves no `Request` and gets only the rpc fix.
  
  The re-exported `@statewalker/webrun-http-streams` API now has `HttpExchange` and `EXCHANGE_ABANDONED_MESSAGE`. Breaking: `HttpDataHandler`'s third argument `exchange: HttpExchange` is required, so code that calls a handler itself must pass one.

### Patch Changes

- Updated dependencies [eec24c8]
- Updated dependencies [cf94377]
- Updated dependencies [12048dd]
  - @statewalker/webrun-rpc@0.8.0
  - @statewalker/webrun-http-streams@0.4.0

## 0.9.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-rpc crosses a breaking line

### Patch Changes

- 29cba96: An abort of a request's signal ends its response body at once, whether a read is waiting or not. `fetchOverDuplex` used to look at the signal only when the next chunk arrived, so a read waiting on a peer that sent nothing more hung, and an unread body kept its call (on a multiplexed link, its port) until someone read it. Now the abort errors the body with the abort's reason, rejects a waiting read, and abandons the call. A link's `inflight` count and `whenIdle()` drop the request at the abort too. The listener on the signal is removed once the body ends, however it ends. A body cancelled while a read waits on a quiet peer no longer keeps its call (and its port) open for good: the read in flight decides. If it brings the body's end, the call is finished as for a body read to its end, so an upload the handler reads after answering goes on; otherwise the call is abandoned, after at most 1 s when the peer sends nothing more. `cancel()` does not wait for either.
- Updated dependencies [29cba96]
- Updated dependencies [ec33737]
- Updated dependencies [626599d]
  - @statewalker/webrun-http-streams@0.3.2
  - @statewalker/webrun-rpc@0.7.0

## 0.8.0

### Minor Changes

- de98774: Built against `@statewalker/webrun-rpc` 0.6 (bundled into the `sw`, `relay-sw` and `sw-worker` entries). No API change.

### Patch Changes

- f062c1d: A worker's first `service.fetch` no longer loses its call when it runs before the worker's first link has arrived. The worker asked its page to attach it again, the page did, and the duplicate link replaced the one the call was already running on: the call failed with "webrun-rpc: the peer abandoned the stream" or, 30 s later, "The link was closed; it may or may not have been applied." Links sent to a worker are now numbered, a relink request says which one the worker has, and the page attaches again only when the worker has its latest link, not while that link is on its way.
- Updated dependencies [30d2cff]
- Updated dependencies [f98d2c4]
- Updated dependencies [76c3b6d]
  - @statewalker/webrun-rpc@0.6.0

## 0.7.1

### Patch Changes

- b224431: Ready for `await using` where the runtime has `Symbol.asyncDispose`: `connect`'s calls and `duplexOverPort`'s caller streams dispose as `return()` (the stream ends at once, even with a `next()` pending), and an `HttpLink` disposes as `close()`. Native async generators get this from `AsyncIteratorPrototype` in runtimes that implement it; these hand-written iterators carry it themselves. Installed at run time only, and kept off the declared types, which would otherwise require the `esnext.disposable` lib.
- a7d06aa: HTTP links (`connectHttpLink` / `serveHttpLink`, so the same-origin dispatcher's links to handlers, workers' links through it, and the relay's) give every request's multiplexed port back when its exchange ends, with webrun-http-streams' and webrun-rpc's fixes bundled in. Before, each GET or POST whose response was read to its end kept its port, an aborted request to a handler that never answered kept its port, and a link stopped taking requests after 1024 of them. An exchange ends when the response is over and the handler is done with the request body (it may answer first and read the upload afterwards). `HttpLinkOptions` takes `maxPorts`, the ceiling on requests in flight on a link at once (default 1024), and, for the answering end, `requestIdleMs`: how long a request body may sit unread after the response before the exchange is ended (default 30 s).
  
  The bundles no longer carry the HTTP stack into code that does not use it: a page that imports only the WebSocket client (`createWebSocketClass`) bundles about 8 KB of it instead of 20 KB, the server end (`upgradeWebSocket`, `ServerWebSocket`) about 6 KB instead of 18 KB.
- Updated dependencies [b224431]
- Updated dependencies [a7d06aa]
- Updated dependencies [a7d06aa]
- Updated dependencies [839e6f7]
  - @statewalker/webrun-rpc@0.5.1
  - @statewalker/webrun-http-streams@0.3.1
  - @statewalker/webrun-streams@0.2.3

## 0.7.0

### Minor Changes

- ba6ae47: ServiceWorker HTTP over webrun-rpc, handlers in Dedicated Workers, restarts, and WebSockets (#31).
  
  - **Streams with backpressure (#32).** Same-origin and relay requests move over webrun-rpc links (`connect` / `serve` over `overPipe`) with webrun-http-streams' `fetchOverDuplex` / `serveFetchOverDuplex`: one-chunk windows in both directions, and an aborted `fetch` reaches the handler as a cancellation. Every hand-shake carries `HTTP_LINK_PROTOCOL`; version-1 peers are still served over the old transport, and a page whose worker is older gets `ServiceWorkerControlError` with the new `reason: "incompatible"`. `streamTimeout` option on `SwHttpAdapter`, the dispatcher, the relay and `initHttpService`. The same-origin worker no longer calls `respondWith` for urls of keys it never served.
  - **Handlers in Dedicated Workers, routing and hand-over (#33).** `adapter.attachWorker(worker, { key, id, meta })` + `serveHttpInWorker(handler)` (new `./worker` entry): the ServiceWorker talks to the worker directly. The dispatcher keeps several handlers per key and routes with a `route(request, key, handlers)` option (default `leastInflightRoute`); `link.drain({ ms })` / `link.detach()` hand a slot over, naming the attachment's owner token. `sw-worker.js` reads options from `self.HTTP_DISPATCHER_OPTIONS`.
  - **Restarts and liveness (#34).** After a restart the ServiceWorker asks every window to attach its links again (`NEED_LINKS`) instead of re-asking stored client ids; handlers hold an owner Web Lock (their requests in flight fail with 502 when they die), the ServiceWorker a router lock (a worker's calls through it fail with `LinkLostError`, and the next ones wait for a link and wake it), and workers keep it awake while their calls are in flight.
  - **WebSockets over MessagePorts (#35).** `createWebSocketClass(connect)` (a WHATWG `WebSocket` class), `upgradeWebSocket(request)` / `ServerWebSocket` (the handler's end), heartbeat, and acknowledgements that make `bufferedAmount` real and give the server end `whenDrained()`.
  - **Opening sockets (#36).** `adapter.connectWebSocket` / `adapter.WebSocket`, `serviceWorkerWebSocketClass()` for any controlled page, `service.WebSocket` in workers (worker to worker through the router), and `callWebSocketService` / `relayWebSocketClass` through a relay; the relay worker also brokers sockets for content on its own origin.
  - **Relay registration (#13).** `canRegister(client, key, path)` sees where a key would be mounted; `UNREGISTER` is accepted only from the key's holder (or, once it is gone, a client `canRegister` allows); the cleanup of `initHttpService` / `registerConnectionsHandler` returns a promise that settles once the relay acknowledged.
  
  API changes to know about:
  
  - `SwHttpAdapter` and `SwHttpDispatcher` no longer extend `SwPortHandler` / `SwPortDispatcher` (both still exported, for subclasses of version 1): `instanceof` those bases, overrides of `_setCommunicationPort`, `loadChannelInfo` and `handlersIndex` are gone. The adapter's `bindPort` option is ignored. `start()`, `stop()`, `register()`, `rootUrl`, `scope`, `serviceWorkerUrl` and `startHttpDispatcher` are unchanged.
  - `initHttpService` and `registerConnectionsHandler` resolve `() => Promise<void>` (still callable as `() => void`).

### Patch Changes

- Updated dependencies [ba6ae47]
- Updated dependencies [ba6ae47]
  - @statewalker/webrun-http-streams@0.3.0
  - @statewalker/webrun-rpc@0.5.0

## 0.6.5

### Patch Changes

- ec75a83: The default worker urls name scripts the build ships. `getRelayWindowMessageHandler()`
  without `swUrl` registers `dist/relay-sw.js` with scope `dist/` (it pointed at a
  missing `index-sw.js`, scoped wider than a `dist/` script may claim), and
  `SwPortHandler` without `serviceWorkerUrl` uses `sw-worker.js` at its scope.
  `SwPortHandler.stop()` unregisters only the registration its own `start()` made,
  instead of every ServiceWorker registration of the origin.

## 0.6.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/webrun-http-streams@0.2.5
  - @statewalker/webrun-rpc@0.4.3
  - @statewalker/webrun-streams@0.2.2

## 0.6.0

### Minor Changes

- 8b789ef: Relay services can be mounted at a path, including the origin root, with keys
  and paths chosen by the host and carried on REGISTER. Several services can
  share one relay connection: a CONNECT is routed to the service named by its
  key, so an app at `/` and a gateway at `/peers/` can register over the same
  port without answering each other's calls. Routing is by longest matching
  prefix, and the matched prefix is NOT stripped — a handler mounted at
  `/peers/` receives `/peers/…`.

  A request matching no mount is not the relay's: the worker does not call
  `respondWith` for it at all, so the browser performs it exactly as it would
  with no worker installed, and a host keeps serving its own files. (Requests
  arriving in the moment before the registry has been read back are the one
  exception: the table cannot be consulted synchronously yet, so they are
  claimed and re-issued.) `exclude` reserves paths from a root mount — and from
  the `/~<key>/` spelling too — and must also cover the host's own entry page,
  not just the relay page and worker script, or a reload cannot get past a root
  mount.

  A mount declared in `mounts` belongs to the host: a page's REGISTER or
  UNREGISTER naming the same key never replaces or removes it, so the page can
  register with no `path` of its own. A mount an earlier REGISTER created is
  still replaced by a path-ful REGISTER and removed by a path-less one.

  New: `@statewalker/webrun-http-browser/relay-worker`, the relay worker
  runtime as a typed ES module — `startRelayServiceWorker`, with
  `RelayServiceWorkerOptions` and `MountSpec` — for a host that bundles its own
  worker, and for typing `self.RELAY_OPTIONS`. The prebuilt `dist/relay-sw.js`
  still reads its options from `self.RELAY_OPTIONS`, set by the host's own
  worker script before `importScripts`, since a classic worker cannot otherwise
  receive arguments. New options: `mounts`, `exclude`, `canRegister`,
  `takeover`, `decorateResponse`. Mounting at `/` should be paired with
  `takeover: "first-wins"` and `canRegister`.

  Fixes: `splitServiceUrl` treated any URL containing `~` as a service URL,
  including `?q=~foo`; it is now anchored to the pathname, and it still splits
  root-relative input (`/~FS/a/b`), which anchoring had broken. Registrations
  record `{ clientId, path }`, and the earlier bare-client-id shape is still
  read, so a returning visitor's services survive. A connection carrying more
  than one registered service had every `CONNECT` answered by every service,
  colliding on the same transferred port; a `CONNECT` is now delivered only to
  the service named by its key.

## 0.5.0

### Minor Changes

- 8bf5ee6: Never hang when the page is not controlled by its ServiceWorker.

  `SwHttpAdapter.start()` and the relay page's `initServiceWorker` waited for
  `navigator.serviceWorker.controller` with no bound, resolving only on
  `controllerchange`. A page that loads uncontrolled while its worker is already
  active — a hard reload (Ctrl+Shift+R), which bypasses the worker for that load
  after its `clients.claim()` has long run; or a page Firefox leaves uncontrolled —
  never gets that event, so `start()` hung forever.

  - Same-origin mode (`SwHttpAdapter.start()`): an uncontrolled page asks its
    worker to claim it (a new `CLAIM` channel call, which both bundled workers
    answer with `clients.claim()`) and waits for `controllerchange`. Verified in
    Chromium and Firefox to take over a hard-reloaded page.
  - Relay mode (`initServiceWorker`, `getRelayWindowMessageHandler`): the relay
    only messages its worker, so an uncontrolled relay page bridges to
    `registration.active` instead of waiting for control. A relay that cannot
    start answers the parent's calls with the error instead of leaving them
    unanswered.
  - Every wait is bounded: new `timeout` option (default 30 s) on
    `SwHttpAdapter`/`SwPortHandler`, `initServiceWorker` and
    `getRelayWindowMessageHandler`. Past it, or when the page stays uncontrolled,
    the promise rejects with a `ServiceWorkerControlError`
    (`reason: "activation-timeout" | "uncontrolled" | "unresponsive"`) whose
    message says what happened and what to do. A failed `start()` can be retried.
  - New opt-in `reloadIfUncontrolled` option on `SwHttpAdapter`: reload once
    instead of rejecting, guarded by `sessionStorage` so it cannot loop.
  - New exports: `awaitServiceWorkerControl`, `awaitActiveServiceWorker`,
    `handleClaimRequests` (for a worker script of your own),
    `ServiceWorkerControlError`, `DEFAULT_SERVICE_WORKER_TIMEOUT`, `CLAIM_CALL`;
    `newServiceWorkerPort` takes an optional registration.
  - Vite consumers of the root entry no longer emit a dead ~91 KB copy of
    `dist/index.js`: the relay defaults no longer use the literal
    `new URL("../", import.meta.url)` pattern that Vite turns into an asset.

## 0.4.2

### Patch Changes

- Updated dependencies [fbaee6a]
  - @statewalker/webrun-rpc@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [0e435d6]
  - @statewalker/webrun-rpc@0.3.0

## 0.4.0

### Minor Changes

- ff650fc: Replace stop-and-wait flow control with credit-based flow control in `emulateMux`.

  **Wire format changed and is incompatible with peers predating this release.**
  OPEN and ACK frames now carry a uint32 credit payload. A peer running the old
  protocol cannot interoperate with one running this version; both sides of a
  connection must be upgraded together. `emulateMux` now costs one additional
  round trip per stream at open time, to establish the initial credit window.

  Every package that embeds `emulateMux` is bumped explicitly here — rather than
  left to the automatic "dependent" bump — because a dependent-only changelog
  entry does not mention a protocol break, and consumers need to see one:
  `@statewalker/webrun-rpc` (renamed from `@statewalker/webrun-streams-port`),
  `@statewalker/webrun-streams-ws`,
  `@statewalker/webrun-streams-peerjs`, and `@statewalker/webrun-streams-livekit`
  all embed the new wire format and gain a `mux` parameter on their connection
  params (`PortParams`, `ConnectWsParams`/`ServeWsParams`, and the peerjs/livekit
  equivalents). `@statewalker/webrun-streams-webrtc` and
  `@statewalker/webrun-streams-libp2p` multiplex natively and are unaffected;
  they still pick up the automatic dependent bump from
  `updateInternalDependencies: "minor"`.

  `@statewalker/webrun-streams` itself adds new exports (`newCreditLedger`,
  `CreditLedger`, `newCreditGrantor`, `CreditGrantor`) and two smaller behavior
  changes on the same minor: `emulateMux` now throws `RangeError` for
  `maxStreamBuffer < 1`, where it previously accepted it silently, and a
  window above `2^32 - 1` is now advertised as `2^32 - 1` instead of wrapping.

  `@statewalker/webrun-streams-conformance`'s `MakePair` gains a parameter, and
  adds a new L6 conformance level.

  `@statewalker/webrun-http-browser` is bumped explicitly rather than left to
  the dependent bump: `src/core/index.ts` re-exports
  `@statewalker/webrun-streams` in full (`export * from "@statewalker/webrun-streams"`),
  so the four new credit-ledger exports above, plus Task 6's four
  `MessageTarget` types, become public exports of this package too.

  The RPC tier (`webrun-rpc`'s send/receive) is unchanged here; its move from
  `webrun-streams-port` and its retyping to accept any `MessageTarget` are
  credited separately, in the `port-layer-to-webrun-rpc` changeset.

### Patch Changes

- 2291ab3: Cancellation now reaches the producer, across every adapter.

  Nine defects, found by putting one unchanged HTTP site in front of a real
  Chromium and measuring what happened when a caller walked away. They formed a
  chain — each one hid the next, so none could be fixed alone.

  **Teardown that never reached the producer.** `duplexOverStream` awaited a
  `.return()` that is queued behind a pending `next()`, so it hung for ever;
  `emulateMux`'s outbound pump checked `closed` only _after_ a chunk arrived, so
  the producer leaked. Both acquire the iterator once and cancel without awaiting
  now. `framedOutbound` also stopped telling a _server's_ handler that its caller
  had gone — a regression introduced while fixing the first two, and caught by a
  test rather than by review.

  **Cancellation that stopped at the adapter.** `toReadableStream` had no `cancel`
  at all, so a cancelled response body never released the iterator feeding it; it
  also drained its whole source inside a single `pull`, which defeated the
  stream's own backpressure and left no point between chunks at which a
  cancellation could take effect. `fromReadableStream` never released its reader,
  so an early exit — `break`, `.return()`, an error — left the source stream
  uncancelled and its producer running. Between them they broke every abort path
  in the repo.

  **A transport with no cancellation message.** Closing a `MessagePort` does not
  notify its peer, so the ServiceWorker HTTP transport's teardown was invisible on
  the far side and a browser handler kept producing for the life of the page after
  its caller had gone. It sends one now, and the receiving channel releases what
  it is sending — without awaiting, because `.return()` on a parked generator is
  queued behind its own pending `next()`.

  **A worker url that could not be relative.** `new URL("/sw-worker.js")` with no
  base throws `Invalid URL` from a _constructor_, naming neither the option nor
  the value. A worker url is relative to the document that registers it, so it is
  resolved against `location.href` now.

  **A port stack that only accepted `MessagePort`.** `PortParams.port` and
  `byteChannelFromMessagePort` were narrowed to `MessagePort` though neither uses
  more than the `MessageTarget` surface they are otherwise written against. The
  narrowing shut out every virtual port — including one backed by a libp2p stream,
  which is how a mesh hands out ports at all. Found by `tsc`.

  A ServiceWorker _is_ told when its client aborts: `request.signal` never fires
  in Chromium, but the `ReadableStream` given to `respondWith` has its `cancel()`
  invoked. That measurement is what established these as transport defects rather
  than a platform limit, and it was taken with none of the code under suspicion.

  Regression tests live beside each fix: `readable-streams-cancel.test.ts`,
  `emulate-mux-cancel-input.test.ts`, `cancel-open-input.test.ts`,
  `cancel-server-handler.test.ts`, `http-cancel.test.ts` (which reproduces the
  browser leak with two plain `MessagePort`s and no ServiceWorker), and
  `sw-worker-url.test.ts`.

  Backpressure on the deprecated ServiceWorker transport is untouched and its
  deprecation note remains true: `sendStream`'s chunk sender still discards the
  promise it is given.

- c6dc18d: The port layer moves to `@statewalker/webrun-rpc`, renamed from
  `@statewalker/webrun-streams-port`.

  **Both packages are still on 0.x, where `minor` is the breaking channel, so
  these are declared `minor` and land as 0.2.0 — not `major`, which changesets
  would take straight to 1.0.0. The changes below are breaking regardless of the
  bump level; read them as such.**

  `webrun-rpc` breaks twice over: the npm package name changed, and `openPort`
  is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
  `structuredCodec` and the port envelope types, and its RPC primitives —
  `callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
  `send`, `recieve` — now accept any `MessageTarget` rather than only a
  `MessagePort`.

  `webrun-streams` breaks because it loses those exports. It keeps generic
  stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
  async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
  consumes it and touches nothing port-related.

  `webrun-http-browser` only repoints a one-line re-export, so it is a patch.

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [3c0f98a]
- Updated dependencies [c6dc18d]
- Updated dependencies [4f958b9]
  - @statewalker/webrun-streams@0.2.0
  - @statewalker/webrun-rpc@0.2.0
  - @statewalker/webrun-http-streams@0.2.2

## 0.3.4

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-http-streams@0.2.1
  - @statewalker/webrun-streams@0.1.1
