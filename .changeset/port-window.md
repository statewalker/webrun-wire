---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": minor
---

Per-port flow control for `multiplexPort` / `overPipe`, off unless `window` (bytes) is set.

- Each port has at most `window` bytes delivered to the other side and not yet consumed, in both directions, so a slow consumer holds its own port's budget and no other port's. What exceeds it waits in the port's send queue; `portBufferedAmount(port)` and `whenPortReady(port, below)` let senders wait. `whenPortReady` always resolves on a later task.
- A message counts as consumed when its listeners return, or their promises settle. Credit goes back in batched `credit` envelopes.
- Safe against older peers: neither end holds back until the other has shown it reads credit — the responder's zero-byte `credit` ack proves it to the opener, and the opener's answer to that ack proves it to the responder. A peer that never answers credit keeps running without flow control.
- `PortCodec` may implement `encode(envelope)` / `decode(data)` so the window counts exact wire bytes; `msgpackCodec` does, and accepts the `credit` envelope.
- `mux.ports()` reports a windowed port's `window` (once in force), `queued`, `outstanding` and `unconsumed` bytes.
