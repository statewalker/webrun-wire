---
"@statewalker/webrun-http-streams": minor
"@statewalker/webrun-rpc": patch
---

A `Request` served by `serveFetchOverDuplex` (and so by `serveHttpLink`) now has a `signal` that aborts when the exchange is abandoned before it is over: the caller left or its transport went away, or the serving side tore the stream down. A handler waiting before it answers, such as a long poll, can stop. `httpServe` handlers get it as a third argument, `exchange.signal` (`HttpExchange`); the reason is `EXCHANGE_ABANDONED_MESSAGE`. A completed exchange never aborts. `newHttpServerStub` requests do not carry it.

`webrun-rpc`'s `serve` now forwards `return()` to a handler's output at once instead of queueing it behind a pending `next()`, and an aborted stream returns the handler's output directly even when `maxMessageSize` chunking wraps it. Together they let the abandonment arrive while the handler still waits.
