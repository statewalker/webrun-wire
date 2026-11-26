# @statewalker/webrun-streams-conformance

## 0.8.0

### Minor Changes

- 10c546a: `newMessagePipe`'s `target.close(reason?)` takes a reason: it becomes the pipe's signal reason and reaches the transport's `close`, so a relay can end one side with the reason the other ended with. The message pipe contract checks it (#218).

### Patch Changes

- Updated dependencies [10c546a]
  - @statewalker/webrun-streams@0.7.0

## 0.7.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.1 -> ^0.6.2

## 0.7.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.0 -> ^0.6.1

## 0.7.0

### Minor Changes

- d9dc580: Native ports get a per-port flow-control window (statewalker/webrun-wire#153). With `window` (bytes) on both ends, `libp2pPortMux` (protocol `windowProtocolOf(protocol)`, with fallback to `protocol`) and `webrtcPortMux` (data channel `protocol` `WINDOW_CHANNEL_PROTOCOL`, then the serving end's hello) agree a window per port: each end holds the peer's messages to the window it grants, and `webrun-rpc`'s stream tier pipelines chunks on such a port, up to the peer's window in flight, instead of waiting for each chunk's confirmation. A window is at least 64 KiB (`MIN_PORT_WINDOW`), so where the peer is known to speak it, a port pipelines up to that floor from its first message, with no round trip. Off by default; against a peer without it, a port runs as before. The window lives once, in `newNativePortMux` (`window` option, `NativeChannel.window`); `portFlow(port)` exposes its state, and `describePortWindow` in `webrun-streams-conformance` is its contract suite.

### Patch Changes

- Updated dependencies [d9dc580]
  - @statewalker/webrun-streams@0.6.0

## 0.6.0

### Minor Changes

- a3429b4: One port-lifecycle module behind the WebRTC and libp2p native port muxes (#152).
  
  - `@statewalker/webrun-streams` adds `newNativePortMux`. It owns the codec over each channel's bytes, messages held until a port's first listener, close signals, accept and refuse, binding of the caller's signal, and close-all. It also adds the `ValueCodec`, `NativePort` and `NativeChannel` types.
  - `webrtcPortMux` and `libp2pPortMux` are built on it. Each supplies only how to open a channel, how inbound channels arrive, and the channel's bytes: the data channel goes through `newMessagePipe`, the stream through `messageTargetOverStream`.
  - `DataChannelPort` and `StreamPort` are now the shared `NativePort`.
  - libp2p now holds messages that arrive before a port's first listener, as WebRTC did.
  - A frame neither transport can decode now fails the port the same way on both. Over libp2p that still resets the stream.
  - `@statewalker/webrun-streams-conformance` adds `describePortMux`, the contract suite. It runs against an in-memory transport, against libp2p, and against WebRTC (in the browser suite).
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

## 0.5.0

### Minor Changes

- e86fe11: Two new L3 cases, run by every adapter: a handler that reads its input while the caller cancels (its `finally` must run), and while the caller's input throws (its read must throw that error, not end cleanly) (#124, #141).

### Patch Changes

- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
  - @statewalker/webrun-streams@0.4.0

## 0.4.0

### Minor Changes

- a4d705c: **Breaking: L6 is redefined around run-ahead, and `PairTuning` is reshaped (spec D17).** `PairTuning` is now `{ maxMessageSize?: number }`; `mtu` and `maxStreamBuffer` described `emulateMux`'s window, which is gone. `ConnectServePair` gains an optional `runAheadBytes`: the most bytes a producer may get ahead of a consumer that stopped reading.
  
  L6 now has three tests:
  - A 256 KiB body crosses as 4 KiB messages to a slow consumer, intact.
  - In each direction, a producer facing a consumer that stops after one chunk must stall within `runAheadBytes`, then finish with every byte intact once the consumer resumes.
  
  A pair that declares no bound gets the completion check alone. Measured bounds:
  
  | Pair | Bound |
  | --- | --- |
  | Loopback | 0 |
  | Port stack | 0 (declared one 4 KiB chunk) |
  | `-webrtc` | 4 MiB, its window |
  | `-libp2p` | none: 22–24 MiB ahead until libp2p aborts the stream; recorded in its README |

### Patch Changes

- e5e180b: **Breaking: `emulateMux` is removed (Plan C3).** Every transport now runs `webrun-rpc`'s port stack. Each adapter gives a pipe (`messageTargetOver…`), `overPipe` with `msgpackCodec` invents a port per call on it, and `webrun-rpc`'s `connect` / `serve` run one call per port. On that stack a producer stays at most one chunk ahead of its consumer; `emulateMux` buffered up to its 8 MiB window. The wire format changes, so both ends must upgrade together.
  
  - `webrun-streams`: `emulateMux`, `EmulateMuxOptions` and `ByteChannel` are gone. `newCreditLedger` / `newCreditGrantor` stay exported, dormant, as the mechanism for per-stream windowing (spec D13).
  - `webrun-streams-ws`, `-peerjs`, `-livekit`: the `emulateMux`-based `connect` / `serve` and `byteChannelFromWebSocket` / `byteChannelFromPeerJs` / `byteChannelFromLiveKit` are gone. Use `messageTargetOverWebSocket` / `messageTargetOverPeerJs` / `messageTargetOverLiveKit` with `overPipe` (see each README). None of the three has a runtime dependency left.
  - `webrun-rpc`: `byteChannelFromMessagePort` is gone; a `MessagePort` goes to `overPipe` directly.
  - `webrun-streams-signaling`: `ByteChannel` is now declared here, with the same shape, and the package has no runtime dependency. Import the type from this package instead of `webrun-streams`. New `messageTargetOverByteChannel(channel)` runs the port stack over a channel this package hands back, reporting 16 KiB − 256 as `maxMessageSize`.
  - `webrun-streams-conformance`: comments only. `PairTuning` is unchanged here, and every pair now ignores it until D17 redefines L6.
  - `webrun-http-streams`: comments only. Its peer-error slot test now runs on the port stack.
  
  `webrun-streams-signaling` also fixes `byteChannelFromRoom`, which never ended. It now closes when the room disconnects, when its participant leaves, or when a reliable publish fails, and it ignores packets that carry no participant. Before this, anything run over it (now the port stack) hung when the other end went away.
- Updated dependencies [e5e180b]
  - @statewalker/webrun-streams@0.3.0

## 0.3.4

### Patch Changes

- Release of the changes since the last published version:
  
  - vitest ^5.0.3 -> ^5.0.5

## 0.3.3

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.2.0

### Minor Changes

- ff650fc: Replace stop-and-wait flow control with credit-based flow control in `emulateMux`.

  **Wire format changed and is incompatible with peers predating this release.**
  OPEN and ACK frames now carry a uint32 credit payload. A peer running the old
  protocol cannot interoperate with one running this version; both sides of a
  connection must be upgraded together. `emulateMux` now costs one additional
  round trip per stream at open time, to establish the initial credit window.

  Every package that embeds `emulateMux` is bumped explicitly here — rather than
  left to the automatic "dependent" bump — because a dependent-only changelog
  entry does not mention a protocol break, and consumers need to see one:
  `@statewalker/webrun-rpc` (renamed from `@statewalker/webrun-streams-port`),
  `@statewalker/webrun-streams-ws`,
  `@statewalker/webrun-streams-peerjs`, and `@statewalker/webrun-streams-livekit`
  all embed the new wire format and gain a `mux` parameter on their connection
  params (`PortParams`, `ConnectWsParams`/`ServeWsParams`, and the peerjs/livekit
  equivalents). `@statewalker/webrun-streams-webrtc` and
  `@statewalker/webrun-streams-libp2p` multiplex natively and are unaffected;
  they still pick up the automatic dependent bump from
  `updateInternalDependencies: "minor"`.

  `@statewalker/webrun-streams` itself adds new exports (`newCreditLedger`,
  `CreditLedger`, `newCreditGrantor`, `CreditGrantor`) and two smaller behavior
  changes on the same minor: `emulateMux` now throws `RangeError` for
  `maxStreamBuffer < 1`, where it previously accepted it silently, and a
  window above `2^32 - 1` is now advertised as `2^32 - 1` instead of wrapping.

  `@statewalker/webrun-streams-conformance`'s `MakePair` gains a parameter, and
  adds a new L6 conformance level.

  `@statewalker/webrun-http-browser` is bumped explicitly rather than left to
  the dependent bump: `src/core/index.ts` re-exports
  `@statewalker/webrun-streams` in full (`export * from "@statewalker/webrun-streams"`),
  so the four new credit-ledger exports above, plus Task 6's four
  `MessageTarget` types, become public exports of this package too.

  The RPC tier (`webrun-rpc`'s send/receive) is unchanged here; its move from
  `webrun-streams-port` and its retyping to accept any `MessageTarget` are
  credited separately, in the `port-layer-to-webrun-rpc` changeset.

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
