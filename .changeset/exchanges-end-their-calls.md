---
"@statewalker/webrun-http-streams": patch
---

`httpFetch` (and so `fetchOverDuplex`) ends its call however the exchange ends. A response body read to its end left the call open, and on a multiplexed transport (webrun-rpc's `connect`) that kept one port per exchange: every GET or POST over one link held a port for good, and the link refused calls with `webrun-rpc: maxPorts (1024) reached` after 1024 of them.

- A body read to its end, or a response with none (HEAD, 204, 304...), now reads the call to its end in the background (`HttpFetchResult.finish()`): the peer ends the call once its side of the exchange is over. A body left early abandons the call, as before.
- On the serving side, `serveFetchOverDuplex` ends its side once the response is out and the handler is done with the request body: a handler that answers first (`202`) and reads the upload afterwards gets all of it; a body it never took is cancelled. `HttpDataHandlerResult` takes the hook for that, `settled`; `release` is called only for a response abandoned before its end.
- The call also ends when the response cannot be decoded, and when the request's signal aborts while the head is awaited: the exchange rejects with the signal's reason at once (it used to wait for the head). `HttpDataOptions` takes that `signal`.

The module-level codec and constants are annotated pure, so a bundle that does not use the HTTP codec drops it.
