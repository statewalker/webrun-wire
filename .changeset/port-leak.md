---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` / `overPipe` take `onLeak`, a development aid: a port its consumer dropped without `close()` is reported with its `PortInfo` once the garbage collector reclaims it, and freed on both ends (the peer sees reason `"leaked"`). The mux no longer holds a consumer's port object, only its own record, and `openPort`'s `signal` holds its port weakly, so a dropped port can be collected.
