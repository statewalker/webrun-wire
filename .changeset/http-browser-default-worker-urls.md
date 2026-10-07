---
"@statewalker/webrun-http-browser": patch
---

The default worker urls name scripts the build ships. `getRelayWindowMessageHandler()`
without `swUrl` registers `dist/relay-sw.js` with scope `dist/` (it pointed at a
missing `index-sw.js`, scoped wider than a `dist/` script may claim), and
`SwPortHandler` without `serviceWorkerUrl` uses `sw-worker.js` at its scope.
`SwPortHandler.stop()` unregisters only the registration its own `start()` made,
instead of every ServiceWorker registration of the origin.
