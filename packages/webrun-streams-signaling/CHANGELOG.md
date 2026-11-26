# @statewalker/webrun-streams-signaling

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [10c546a]
  - @statewalker/webrun-streams@0.7.0

## 0.5.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.1 -> ^0.6.2

## 0.5.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.0 -> ^0.6.1

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [d9dc580]
  - @statewalker/webrun-streams@0.6.0

## 0.4.0

### Minor Changes

- 98242dc: One pipe module behind the four `messageTargetOver*` adapters (#151).
  
  - `@statewalker/webrun-streams` adds `newMessagePipe(transport, options)`. It owns the listener set, delivery that a faulty listener cannot stop, the pipe's life, the byte check on `postMessage`, the frame ceiling, `bufferedAmount` / `whenDrained` and `close()`. A transport supplies only `send`, its buffered bytes, its drain wait and its close.
  - `messageTargetOverWebSocket`, `messageTargetOverPeerJs`, `messageTargetOverLiveKit` and `messageTargetOverByteChannel` are now built on it, and depend on `@statewalker/webrun-streams` at runtime. Each target now carries `closeSignal` and `maxMessageSize`. The WebSocket and byte-channel adapters gain an optional `maxFrameBytes` (unset by default, as before), and the WebSocket adapter an optional `maxMessageSize`.
  - `@statewalker/webrun-rpc`'s `overPipe` takes `signal` and `maxMessageSize` from the pipe's own `closeSignal` and `maxMessageSize` when they are not given, so `overPipe(target, { codec, side })` is enough.
  - `@statewalker/webrun-streams-conformance` adds `describeMessagePipe`, the pipe contract suite. It runs against an in-memory transport and against each adapter.
  
  Existing call sites keep working: adapters still return `{ target, signal, maxMessageSize }`.

### Patch Changes

- Updated dependencies [e29084d]
- Updated dependencies [a3429b4]
- Updated dependencies [98242dc]
- Updated dependencies [e4e6228]
  - @statewalker/webrun-streams@0.5.0

## 0.3.0

### Minor Changes

- 337b572: Channels over a data channel end instead of losing messages silently, and the port stack can pace them. `byteChannelFromDataChannel` ends the channel on a non-byte message (it threw inside the listener, dropping the message, so a call waited for ever) and on a `send` that throws (Chrome's full send queue was silent loss). `ByteChannel` gains optional `bufferedAmount` / `whenDrained()`; `byteChannelFromDataChannel` provides them from the data channel, and `messageTargetOverByteChannel`'s `target` exposes them, as the ws, peerjs, livekit and webrtc adapters do, so `overPipe` with `frameSize` waits for the transport. New export `DRAIN_LOW_WATER` (256 KiB).
- 337b572: `PeerManager` no longer leaves failures as unhandled rejections, and forgets failed connections. A signal a connection rejects (an offer during glare, malformed SDP or candidates) and an inbound connection whose channel never opens now close and forget the connection and are reported through the new optional `onError(error, peerId)` option; a failed `connect()` rejects and forgets its connection. A connection whose state becomes `failed` or `closed` is forgotten too, and a new offer from a peer replaces the old connection to it when this side answered that peer or already applied its answer, so either side can reconnect at once; `connect()` replaces any existing connection to the peer. New `PeerConnection.hasRemoteDescription()`. `PeerConnection.open()` rejects when the connection is closed before the channel opens.
- 337b572: `byteChannelFromRoom` now follows `webrun-streams-livekit`'s conventions instead of duplicating its older behaviour. Its packets carry a topic (`options.topic`, default `DEFAULT_ROOM_TOPIC`, `"webrun/port-stack"`) and packets on any other topic are ignored, so another pipe's packets in the same room no longer leak in. Closing one end publishes a goodbye on `<topic>/close`, so the peer's channel ends while the room stays connected. A `send` past `options.maxFrameBytes` (default `DEFAULT_ROOM_MAX_FRAME_BYTES`, 64 000) ends the channel and throws `RangeError`. It also reports `bufferedAmount` / `whenDrained()`. `RoomManager.channelTo(peerId, options?)` passes the options through. Packets now carry a topic, so both ends must upgrade together: an older end's untopiced packets are ignored.

### Patch Changes

- 337b572: `QrSignaling.offer()` no longer starts the connection timeout at offer time. The 30 s `connectionTimeout` ran while people scanned the two QR codes, so a slower exchange made `accept()` return an already-rejected channel, and until `accept()` was called that rejection was unhandled. The timeout now starts in `accept()`, which also closes the connection and rejects if the answer cannot be applied.
- 337b572: QR payloads keep what a candidate needs. `compressCandidate` dropped `raddr` / `rport` / `tcptype`, producing invalid TCP candidates; such a candidate now goes in the existing raw `R:` form with just those attributes. An `sdpMLineIndex` of 0 in a raw candidate no longer comes back as null, and a null one travels as an empty field. Payloads stay readable by older versions.

## 0.2.0

### Minor Changes

- e5e180b: **Breaking: `emulateMux` is removed (Plan C3).** Every transport now runs `webrun-rpc`'s port stack. Each adapter gives a pipe (`messageTargetOver…`), `overPipe` with `msgpackCodec` invents a port per call on it, and `webrun-rpc`'s `connect` / `serve` run one call per port. On that stack a producer stays at most one chunk ahead of its consumer; `emulateMux` buffered up to its 8 MiB window. The wire format changes, so both ends must upgrade together.
  
  - `webrun-streams`: `emulateMux`, `EmulateMuxOptions` and `ByteChannel` are gone. `newCreditLedger` / `newCreditGrantor` stay exported, dormant, as the mechanism for per-stream windowing (spec D13).
  - `webrun-streams-ws`, `-peerjs`, `-livekit`: the `emulateMux`-based `connect` / `serve` and `byteChannelFromWebSocket` / `byteChannelFromPeerJs` / `byteChannelFromLiveKit` are gone. Use `messageTargetOverWebSocket` / `messageTargetOverPeerJs` / `messageTargetOverLiveKit` with `overPipe` (see each README). None of the three has a runtime dependency left.
  - `webrun-rpc`: `byteChannelFromMessagePort` is gone; a `MessagePort` goes to `overPipe` directly.
  - `webrun-streams-signaling`: `ByteChannel` is now declared here, with the same shape, and the package has no runtime dependency. Import the type from this package instead of `webrun-streams`. New `messageTargetOverByteChannel(channel)` runs the port stack over a channel this package hands back, reporting 16 KiB − 256 as `maxMessageSize`.
  - `webrun-streams-conformance`: comments only. `PairTuning` is unchanged here, and every pair now ignores it until D17 redefines L6.
  - `webrun-http-streams`: comments only. Its peer-error slot test now runs on the port stack.
  
  `webrun-streams-signaling` also fixes `byteChannelFromRoom`, which never ended. It now closes when the room disconnects, when its participant leaves, or when a reliable publish fails, and it ignores packets that carry no participant. Before this, anything run over it (now the port stack) hung when the other end went away.

## 0.1.6

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
