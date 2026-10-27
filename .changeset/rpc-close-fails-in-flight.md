---
"@statewalker/webrun-rpc": minor
---

Closing a link fails the calls in flight on it. A virtual port of `multiplexPort` now has a close signal (`getPortCloseSignal`), aborted when the port is closed locally, by the peer, or by `PortMux.close()`; `callPort` already honoured it, and both halves of a `duplexOverPort` stream now abort on it. Before, `close()` on a `connect` link left a call waiting for the peer's next chunk pending forever. The error is `MUX_CLOSED_MESSAGE` ("webrun-rpc: the multiplexer was closed"), newly exported.
