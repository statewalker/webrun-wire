---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-streams-libp2p": minor
"@statewalker/webrun-streams-webrtc": minor
"@statewalker/webrun-streams-conformance": minor
"@statewalker/webrun-rpc": minor
---

Native ports get a per-port flow-control window (statewalker/webrun-wire#153). With `window` (bytes) on both ends, `libp2pPortMux` (protocol `windowProtocolOf(protocol)`, with fallback to `protocol`) and `webrtcPortMux` (data channel `protocol` `WINDOW_CHANNEL_PROTOCOL`, then the serving end's hello) agree a window per port: each end holds the peer's messages to the window it grants, and `webrun-rpc`'s stream tier pipelines chunks on such a port, up to the peer's window in flight, instead of waiting for each chunk's confirmation. Off by default; against a peer without it, a port runs as before. The window lives once, in `newNativePortMux` (`window` option, `NativeChannel.window`); `portFlow(port)` exposes its state, and `describePortWindow` in `webrun-streams-conformance` is its contract suite.
