---
"@statewalker/webrun-rpc": patch
---

A caller that gives up on a stream (`return()` or `throw()` on `connect`'s call, or on `duplexOverPort`'s) while it waits for the peer's next chunk ends the stream at once: the stream is aborted, the peer is told, and the port is closed. Before, an async generator queued the `return()` behind the pending `next()`, so a stream to a peer that never answered — an aborted request to a hung handler — kept its port for good.
