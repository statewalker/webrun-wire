---
"@statewalker/webrun-http-browser": patch
---

`SwHttpAdapter` takes a `type` option and a `registration` option. `type: "module"` registers an ES-module worker, one that imports `startHttpDispatcher` from `sw.js`. Before, the adapter always registered the worker as a classic one, so a module worker failed to start. `registration` hands the adapter a registration the page made itself, with its own script, scope or type. The adapter then registers nothing, takes its scope from that registration, and `stop()` leaves the registration in place. The ServiceWorker side now routes under its registration's scope rather than its script's folder. A worker registered with another scope (`register(url, { scope })`) read the wrong key from every url, so its handlers answered 404.
