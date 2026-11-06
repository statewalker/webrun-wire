---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": minor
---

Fair framing for `multiplexPort` / `overPipe`, off unless `frameSize` (bytes) is set; it needs `window`.

- Every port's messages leave in turn, one per port, whenever the pipe has room, and a message larger than `frameSize` goes as `frame` envelopes the peer reassembles. A small message on one port no longer waits behind a large one on another.
- `MessageTarget` may implement `whenDrained()` / `bufferedAmount` to say when it is full; framing waits on it between frames.
- Frames go only on a windowed port whose two ends agreed exact sizes (`exact: true`); older peers get whole messages. Frames anywhere else are dropped.
- `frameSize` must be a positive integer; anything else is a `RangeError`.
- With `frameSize`, a port without a window posts at once; a `whenDrained()` that rejects closes the mux with its error; `mux.close()` still posts the close of a port whose close was queued behind its frames.
