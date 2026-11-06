---
"@statewalker/webrun-http-streams": minor
"@statewalker/webrun-rpc": patch
---

A served `Request` now has a `signal` that aborts when the caller abandons the exchange (`webrun-http-streams: the caller abandoned the exchange`), so a handler waiting before it answers, such as a long poll, can stop. `httpServe` handlers get it as a third argument, `exchange.signal` (`HttpExchange`). It never aborts once the response went out in full. `webrun-rpc`'s `serve` now forwards `return()` to a handler's output at once instead of queueing it behind a pending `next()`, which is what lets the abandonment arrive while the handler still waits.
