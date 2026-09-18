---
"@statewalker/webrun-http-browser": minor
---

Never hang when the page is not controlled by its ServiceWorker.

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
