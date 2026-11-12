---
"@statewalker/webrun-streams-peerjs": patch
"@statewalker/webrun-streams-livekit": patch
---

New `messageTargetOverPeerJs(conn)` and `messageTargetOverLiveKit(room, peerIdentity)`: a raw PeerJS connection, or one LiveKit participant, as a pipe of bytes for `webrun-rpc`'s port stack (Plan C2). Each returns `{ target, signal, maxMessageSize }`. `target` is a `MessageTarget` with `bufferedAmount` and `whenDrained()`. `signal` aborts when the transport goes. `maxMessageSize` is the payload ceiling to give `overPipe`: 16 KiB − 256 for PeerJS, 12 KiB for LiveKit.

PeerJS's ceiling was measured first, as the spec required. Between two Chromiums, 256 KiB arrives and one byte more arrives as nothing, with the connection silently closed. Firefox to Chrome cuts off at 16 KiB. So a post past `maxFrameBytes` (16 KiB for PeerJS, 15 KiB for LiveKit) ends the pipe with a `RangeError` rather than vanishing. `connect` / `serve` over `emulateMux` are unchanged.
