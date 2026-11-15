---
"@statewalker/webrun-streams": patch
"@statewalker/webrun-streams-libp2p": patch
"@statewalker/webrun-streams-webrtc": patch
---

Security (statewalker/webrun-wire#195): a windowed native port no longer buffers up to the window
its peer announces (up to 4 GiB) for a peer that stopped reading.

- `@statewalker/webrun-streams`: a windowed native port runs at most min(the peer's window, its
  own window) ahead, and sends no data frame while its channel's pipe says it `needsDrain` (the
  frame waits in the port's queue, which `webrun-rpc`'s stream tier already waits on), so at most
  one frame goes past the transport's buffer. `newNativePortMux` takes `drainTimeoutMs`: a write
  that waited for drain longer fails the port and breaks its channel off (a quiet port is never
  timed out). `BytePipeTarget` and `MessagePipeTarget` gain an optional `needsDrain`, which
  `newMessagePipe` sets.
- `@statewalker/webrun-streams-libp2p`: `messageTargetOverStream` exposes `needsDrain` (libp2p's
  `writableNeedsDrain`); `connect`, `serve`, `serveConnections` and `libp2pPortMux` reset a call's
  stream once a write has waited for drain longer than `drainTimeoutMs` (default 5 minutes; no
  longer deprecated, it now applies to the port protocol too). A stalled caller announcing a 4 GiB
  window used to make the server hold the whole response (192 MiB in the regression test, 1 GiB in
  the original report); it now holds under 1 KiB and drops the call after the timeout.
- `@statewalker/webrun-streams-webrtc`: `webrtcPortMux` honours its data channel's buffer
  (`PORT_DRAIN_LOW_WATER`) on windowed ports and takes `drainTimeoutMs` (default
  `DEFAULT_PORT_DRAIN_TIMEOUT_MS`, 5 minutes).
