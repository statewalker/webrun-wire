---
"@statewalker/webrun-rpc": minor
---

`multiplexPort` / `overPipe` take `onLeak`, a development aid: a port its consumer dropped without `close()` is reported with its `PortInfo` once the garbage collector reclaims it, and freed on both ends if it has no listener left (one that still listens is still receiving, and is left open). The mux no longer holds a consumer's port object, only its own record, and `openPort`'s `signal` closes its port through that record, so a dropped port can be collected and is still freed when the signal aborts. `Symbol.dispose` also works detached from its port.
