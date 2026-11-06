---
"@statewalker/webrun-rpc": patch
---

`serve` forwards `return()` to a handler's output at once, instead of queueing it behind a `next()` the handler has not answered yet, so a handler still working on its first chunk learns its caller left. When a stream is aborted with `maxMessageSize` chunking on, the producer itself is returned — the handler's output on the serving side and the caller's input on the calling side — rather than only the chunker wrapping it, which would queue the `return()` the same way.
