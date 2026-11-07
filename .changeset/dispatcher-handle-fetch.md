---
"@statewalker/webrun-http-browser": patch
---

A host's ServiceWorker can take over `fetch` handling from the same-origin dispatcher. With `handleFetch: false` the dispatcher adds no `fetch` listener. The host's own listener decides first (a page no tab serves, routes of its own) and passes the rest to the new `dispatcher.handleFetch(event)`. That method answers what is the dispatcher's and returns whether it called `respondWith`.
