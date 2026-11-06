---
"@statewalker/webrun-http-browser": minor
---

The HTTP link pipelines its bodies. `HttpLinkOptions.window` (bytes, default 256 KiB) is the flow-control window the calling end asks each request's port for; under it, request and response bodies stream without a confirmation per chunk, and a reader that stops holds about one window per link. `window: 0` turns it off and puts exactly the previous envelopes on the wire. The ServiceWorkers' own links take it too (`SwHttpDispatcherOptions.window`, `RelayServiceWorkerOptions.window`), and `callHttpService` passes its options' `window` on. An answering end of an older version falls back to confirmed chunks by itself; `HTTP_LINK_PROTOCOL` is unchanged.
