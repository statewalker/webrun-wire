---
"@statewalker/webrun-http-browser": minor
---

ServiceWorker HTTP over webrun-rpc, handlers in Dedicated Workers, restarts, and WebSockets (#31).

- **Streams with backpressure (#32).** Same-origin and relay requests move over webrun-rpc links (`connect` / `serve` over `overPipe`) with webrun-http-streams' `fetchOverDuplex` / `serveFetchOverDuplex`: one-chunk windows in both directions, and an aborted `fetch` reaches the handler as a cancellation. Every hand-shake carries `HTTP_LINK_PROTOCOL`; version-1 peers are still served over the old transport, and a page whose worker is older gets `ServiceWorkerControlError` with the new `reason: "incompatible"`. `streamTimeout` option on `SwHttpAdapter`, the dispatcher, the relay and `initHttpService`. The same-origin worker no longer calls `respondWith` for urls of keys it never served.
- **Handlers in Dedicated Workers, routing and hand-over (#33).** `adapter.attachWorker(worker, { key, id, meta })` + `serveHttpInWorker(handler)` (new `./worker` entry): the ServiceWorker talks to the worker directly. The dispatcher keeps several handlers per key and routes with a `route(request, key, handlers)` option (default `leastInflightRoute`); `link.drain({ ms })` / `link.detach()` hand a slot over, naming the attachment's owner token. `sw-worker.js` reads options from `self.HTTP_DISPATCHER_OPTIONS`.
- **Restarts and liveness (#34).** After a restart the ServiceWorker asks every window to attach its links again (`NEED_LINKS`) instead of re-asking stored client ids; handlers hold an owner Web Lock (their requests in flight fail with 502 when they die), the ServiceWorker a router lock (a worker's calls through it fail with `LinkLostError`, and the next ones wait for a link and wake it), and workers keep it awake while their calls are in flight.
- **WebSockets over MessagePorts (#35).** `createWebSocketClass(connect)` (a WHATWG `WebSocket` class), `upgradeWebSocket(request)` / `ServerWebSocket` (the handler's end), heartbeat, and acknowledgements that make `bufferedAmount` real and give the server end `whenDrained()`.
- **Opening sockets (#36).** `adapter.connectWebSocket` / `adapter.WebSocket`, `serviceWorkerWebSocketClass()` for any controlled page, `service.WebSocket` in workers (worker to worker through the router), and `callWebSocketService` / `relayWebSocketClass` through a relay; the relay worker also brokers sockets for content on its own origin.
- **Relay registration (#13).** `canRegister(client, key, path)` sees where a key would be mounted; `UNREGISTER` is accepted only from the key's holder (or, once it is gone, a client `canRegister` allows); the cleanup of `initHttpService` / `registerConnectionsHandler` returns a promise that settles once the relay acknowledged.

API changes to know about:

- `SwHttpAdapter` and `SwHttpDispatcher` no longer extend `SwPortHandler` / `SwPortDispatcher` (both still exported, for subclasses of version 1): `instanceof` those bases, overrides of `_setCommunicationPort`, `loadChannelInfo` and `handlersIndex` are gone. The adapter's `bindPort` option is ignored. `start()`, `stop()`, `register()`, `rootUrl`, `scope`, `serviceWorkerUrl` and `startHttpDispatcher` are unchanged.
- `initHttpService` and `registerConnectionsHandler` resolve `() => Promise<void>` (still callable as `() => void`).

