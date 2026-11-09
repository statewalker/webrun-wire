---
"@statewalker/webrun-http-streams": patch
"@statewalker/webrun-http-browser": patch
---

An abort of a request's signal reaches its response body even after the caller has let the `Request` go. In Node, a `Request`'s signal follows the caller's signal only while the `Request` lives (undici holds the Request's controller through a WeakRef), so a caller that kept only the `Response` could abort, and the body (from `fetchOverDuplex`, or an HTTP link's `send`) never saw it: the read went on, and the call, its port and the link's `inflight` stayed taken. The response body now holds its `Request` until it ends, and lets it go then; a call that is finished but not yet ended by the peer holds it until the call ends, so an abort can still abandon it (`HttpDataOptions.keepAlive`, which `fetchOverDuplex` sets). `WorkerHttpService.fetch(request, init)` passes the request's signal on explicitly.
