---
"@statewalker/webrun-http-browser": patch
---

`connectWebSocket` takes headers as a third argument (`HeadersInit`), on a page's `SwHttpAdapter` and on a worker's `serveHttpInWorker` service. The handler sees them on the upgrade request, and so does a `route` function choosing it. A worker's socket to another handler (`ws-open`) used to carry only its url and subprotocols, so a host could not route it by anything else, a shard for instance. The headers are the caller's word, and an older ServiceWorker drops them. A caller's `sec-websocket-protocol` header no longer reaches the upgrade request: `protocols` alone names the subprotocols asked for.
