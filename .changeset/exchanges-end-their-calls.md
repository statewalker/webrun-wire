---
"@statewalker/webrun-http-streams": patch
---

`httpFetch` (and so `fetchOverDuplex`) ends its call however the exchange ends. A response body read to its end left the call's generator open, and on a multiplexed transport (webrun-rpc's `connect`) that kept one port per exchange: every GET or POST over one link held a port for good, and the link refused calls with `webrun-rpc: maxPorts (1024) reached` after 1024 of them. The call now also ends when the response cannot be decoded, and when the request's signal aborts while the response head is awaited: the exchange rejects with the signal's reason at once (it used to wait for the head), and the call ends as soon as the peer answers. `HttpDataOptions` takes that `signal`.

The module-level codec and constants are annotated pure, so a bundle that does not use the HTTP codec drops it.
