---
"@statewalker/webrun-http-streams": minor
---

A `Request` served by `serveFetchOverDuplex` now has a `signal` that aborts when the exchange is abandoned before it is over: the caller left or its transport went away, or the serving side tore the stream down. A handler waiting before it answers, such as a long poll, can stop. A completed exchange never aborts. `newHttpServerStub` requests do not carry it.

`httpServe` handlers get the signal as a third argument, `exchange.signal` (new type `HttpExchange`); the abort reason's message is the new export `EXCHANGE_ABANDONED_MESSAGE`, or the reason is the error itself when the stream was thrown into.

Breaking: `HttpDataHandler`'s third argument `exchange: HttpExchange` is required. Handlers written with two parameters still type-check, but code that invokes an `HttpDataHandler` itself must pass one.
