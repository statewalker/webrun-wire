---
"@statewalker/webrun-http-browser": patch
---

The declarations compile with the DOM lib alone. The ServiceWorker-facing API (`SwHttpDispatcher`'s and `SwPortDispatcher`'s `self`, `handleFetch(event)` and `handleClaimRequests(self)`) named `ServiceWorkerGlobalScope` and `FetchEvent`, which only TypeScript's WebWorker lib has. Every consumer that imported a type from `sw` or the main entry then failed to compile without that lib, unless it skipped lib checks. These now take a `ServiceWorkerScope` and a `FetchEventLike`, both exported: structural types that a ServiceWorker's `self` and its `fetch` events satisfy. `dispatcher.self` is typed as `ServiceWorkerScope` too.
