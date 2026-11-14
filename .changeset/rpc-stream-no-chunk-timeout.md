---
"@statewalker/webrun-rpc": patch
---

The stream tier (`send`, and so `ioSend`, `ioHandle`, `callBidi`, `listenBidi`) no longer fails a consumer that spends more than 1 s on one item: its chunk calls default to `NO_TIMEOUT`, as the docs already described. An explicit `timeout` option still bounds each chunk call.

A handler that stops without reading all of its input no longer leaves the caller waiting for chunk replies that never come: `ioHandle` then posts `cancel-channel` and `ioSend` stops sending, and `callBidi` stops sending once the peer's outer call settles (so an older peer that posts no `cancel-channel` is covered too).
