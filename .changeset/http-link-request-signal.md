---
"@statewalker/webrun-http-browser": minor
---

A `Request` served by `serveHttpLink` now has a `signal` that aborts when the caller leaves before the exchange is over, so a long-polling handler can stop waiting. The bundled `relay-sw.js` and `sw-worker.js` include the same behaviour.

The re-exported `@statewalker/webrun-http-streams` API now has `HttpExchange` and `EXCHANGE_ABANDONED_MESSAGE`. Breaking: `HttpDataHandler`'s third argument `exchange: HttpExchange` is required, so code that calls a handler itself must pass one.
