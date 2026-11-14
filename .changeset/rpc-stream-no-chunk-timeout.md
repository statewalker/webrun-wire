---
"@statewalker/webrun-rpc": patch
---

The stream tier (`send`, and so `ioSend`, `ioHandle`, `callBidi`, `listenBidi`) no longer fails a consumer that spends more than 1 s on one item: its chunk calls default to `NO_TIMEOUT`, as the docs already described. An explicit `timeout` option still bounds each chunk call.
