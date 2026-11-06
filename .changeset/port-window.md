---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": patch
---

Experimental per-port flow control for `multiplexPort` / `overPipe`: `window` (bytes) bounds what
each port has delivered to the other side and not yet consumed, in both directions, so a slow
consumer holds its own port's budget and no other port's. What exceeds the window waits in the
port's send queue; `portBufferedAmount(port)` and `whenPortReady(port, below)` let senders wait. A
message counts as consumed when its listeners return (or their promises settle); credit goes back
in a `credit` envelope, batched. Off unless set; both ends must support it. `msgpackCodec`
accepts the new envelope.
