---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-streams-conformance": minor
"@statewalker/webrun-streams-webrtc": minor
"@statewalker/webrun-streams-libp2p": minor
---

One port-lifecycle module behind the WebRTC and libp2p native port muxes (#152).

- `@statewalker/webrun-streams` adds `newNativePortMux`. It owns the codec over each channel's bytes, messages held until a port's first listener, close signals, accept and refuse, binding of the caller's signal, and close-all. It also adds the `ValueCodec`, `NativePort` and `NativeChannel` types.
- `webrtcPortMux` and `libp2pPortMux` are built on it. Each supplies only how to open a channel, how inbound channels arrive, and the channel's bytes: the data channel goes through `newMessagePipe`, the stream through `messageTargetOverStream`.
- `DataChannelPort` and `StreamPort` are now the shared `NativePort`.
- libp2p now holds messages that arrive before a port's first listener, as WebRTC did.
- A frame neither transport can decode now fails the port the same way on both. Over libp2p that still resets the stream.
- `@statewalker/webrun-streams-conformance` adds `describePortMux`, the contract suite. It runs against an in-memory transport, against libp2p, and against WebRTC (in the browser suite).
