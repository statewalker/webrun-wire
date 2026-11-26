---
"@statewalker/webrun-rpc": minor
---

`callBidi` takes `options.closePort`: set, it closes the port once the stream is over (ended, the handler failed, or the consumer stopped early), so a port opened on a mux for one subscription is not left in the mux. Off by default: the caller owns the port, as documented now (#217).
