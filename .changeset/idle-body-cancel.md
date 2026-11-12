---
"@statewalker/webrun-http-streams": patch
---

An idle body is cancelled as soon as its exchange is torn down. A served handler's response body with no chunk pending (an SSE stream between events, a long poll) was cancelled only once its next chunk came: the transport's `return()`/`throw()` on the served output is queued behind the `next()` waiting on `reader.read()`. The abandoned exchange now cancels the body directly, with the abort's reason (`throw(error)`'s error, or the "abandoned" error for `return()`), and the `next()` in flight settles as done. Likewise a served handler's pending read of its request body fails at once with that reason, a cancel of that body no longer waits for the next chunk, and a caller's streamed upload is cancelled at once when its request's signal aborts. Normal completion cancels nothing; the wire format is unchanged.
