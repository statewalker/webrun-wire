---
"@statewalker/webrun-http-browser": patch
---

A host's ServiceWorker can take over `fetch` handling from the same-origin dispatcher. With `handleFetch: false` on a dispatcher the host constructs, it adds no `fetch` listener. The host's own listener answers its routes and passes the rest to the new `dispatcher.handleFetch(event, request?)`, which can take a rewritten request (cookies the host adds, say). `handleFetch` returns whether it called `respondWith`. A new `unserved(request)` option answers a navigation under the scope whose key nobody serves, including one taken before the stored keys are read after a restart. It defaults to the network, as before, so a host can give its own page for urls no tab serves. Other requests nobody serves still go to the network. `startHttpDispatcher` refuses `handleFetch: false`, since nothing could call `handleFetch` then.
