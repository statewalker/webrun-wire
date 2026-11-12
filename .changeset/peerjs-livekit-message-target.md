---
"@statewalker/webrun-streams-peerjs": patch
"@statewalker/webrun-streams-livekit": patch
"@statewalker/webrun-rpc": patch
---

New `messageTargetOverPeerJs(conn)` and `messageTargetOverLiveKit(room, peerIdentity)`: a raw PeerJS connection, or one LiveKit participant, as a pipe of bytes for `webrun-rpc`'s port stack (Plan C2). Each returns `{ target, signal, maxMessageSize }`. `target` is a `MessageTarget` with `bufferedAmount` and `whenDrained()`. `signal` aborts when the transport goes. `maxMessageSize` is the payload ceiling to give `overPipe`: 16 KiB − 256 for PeerJS, 12 KiB for LiveKit.

PeerJS's ceiling was measured first, as the spec required. Between two Chromiums, 256 KiB arrives and one byte more arrives as nothing, with the connection silently closed. Firefox to Chrome cuts off at 16 KiB. So a post past `maxFrameBytes` (16 KiB) ends the pipe with a `RangeError` rather than vanishing. The connection must be open, raw and reliable, and `close()` flushes before closing.

LiveKit packets carry their own topic. Ending a pipe on one side sends a goodbye that ends the peer's pipe, because the room stays connected. The packet cap is livekit-client's own 64,000 bytes.

`webrun-rpc`: `duplexOverPort` fits the error a stream ends with to `maxMessageSize` before sending it whole. In order, it drops the stack, then the largest extra fields, then the message's tail, and marks the error `truncated: true`. Before this, a large error message, or an error carrying an HTTP body, went out as one oversized message, which a transport with a ceiling drops or dies on.

`connect` / `serve` over `emulateMux` are unchanged.
