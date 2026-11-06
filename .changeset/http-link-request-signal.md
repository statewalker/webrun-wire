---
"@statewalker/webrun-http-browser": minor
---

A `Request` served by `serveHttpLink` now has a `signal` that aborts when the caller leaves before the exchange is over, so a long-polling handler can stop waiting. The self-contained `sw-worker.js` bundle carries it; `relay-sw.js` serves no `Request` and gets only the rpc fix.

The re-exported `@statewalker/webrun-http-streams` API now has `HttpExchange` and `EXCHANGE_ABANDONED_MESSAGE`. Breaking: `HttpDataHandler`'s third argument `exchange: HttpExchange` is required, so code that calls a handler itself must pass one.
