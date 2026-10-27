---
"@statewalker/webrun-http-streams": minor
---

Abandoning a response releases the producer. Leaving `httpFetch`'s body before its end (an aborted `fetch`, a cancelled `Response` stream, a `break`) now returns the call's output generator, so the handler's stream is cancelled and its `finally` runs; before, `.return()` on the body never reached the call. `HttpFetchResult` gains `release()` for a caller that never reads the body (`fetchOverDuplex` uses it for bodyless responses, closing its "known gap"), and `HttpDataHandlerResult` an optional `release` that `httpServe` calls when the response is abandoned before the codec started reading the body (`serveFetchOverDuplex` cancels the `Response` body there).
