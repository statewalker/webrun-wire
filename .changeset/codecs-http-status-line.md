---
"@statewalker/webrun-http-streams": patch
---

`fetchOverDuplex` no longer throws `RangeError` / `TypeError` for a peer's status line, and no longer leaves the call held when it refuses one. The HTTP/1.1 decoder refuses a status outside 100–599 and an invalid reason phrase with `HttpParseError`, skips interim 1xx responses (100 Continue, 103 Early Hints; at most 16) and refuses 101; `fetchOverDuplex` turns any status line `new Response` rejects (for example from the JSON envelope) into an `HttpParseError` and releases the call.
