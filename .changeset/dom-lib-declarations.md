---
"@statewalker/webrun-http-browser": patch
---

The declarations compile with the DOM lib alone. The ServiceWorker-facing API (`SwHttpDispatcher`'s and `SwPortDispatcher`'s `self`, `handleFetch(event)`, `handleClaimRequests(self)`, and `relay-worker`'s `startRelayServiceWorker(self)` with its `canRegister(client)`) named `ServiceWorkerGlobalScope` and `FetchEvent`, which only TypeScript's WebWorker lib has. Every consumer that imported a type from `sw` or the main entry then failed to compile without that lib, unless it skipped lib checks. These now take a `ServiceWorkerScope`, a `FetchEventLike` and a `ServiceWorkerClientLike`, all exported: structural types that a ServiceWorker's `self` and its `fetch` events satisfy. `dispatcher.self` is typed as `ServiceWorkerScope` too. Code that used `dispatcher.self` for WebWorker members (`self.clients.claim()`) casts it, or keeps its own reference to the global `self`.
