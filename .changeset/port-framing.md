---
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-msgpack": minor
---

Fair framing for `multiplexPort` / `overPipe`, off unless `frameSize` (bytes) is set; it needs `window`.

- Every port's messages leave in turn, one per port, whenever the pipe has room, and a message larger than `frameSize` goes as `frame` envelopes the peer reassembles. A small message on one port no longer waits behind a large one on another.
- `MessageTarget` may implement `whenDrained()` / `bufferedAmount` to say when it is full; framing waits on it between frames.
- Frames go only to a peer that says it reassembles them (`frames: true` in its `open` or window acknowledgement); older peers get whole messages.
- `PortCodec`'s optional `prepare` / `size` are replaced by `encode` / `decode`, which `msgpackCodec` implements.
