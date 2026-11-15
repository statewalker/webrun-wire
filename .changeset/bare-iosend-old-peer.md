---
"@statewalker/webrun-rpc": patch
---

A bare `ioSend` no longer waits for ever against an older (0.10) `ioHandle` whose handler returns without reading all of its input. `ioSend` now stops sending once the peer's stream has ended: the peer's `ioHandle` reads nothing more after that, and an older one posts no `cancel-channel`. Output the peer's handler did not read is not sent. `callBidi` was already covered.
