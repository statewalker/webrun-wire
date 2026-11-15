---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-streams-conformance": minor
"@statewalker/webrun-streams-ws": minor
"@statewalker/webrun-streams-peerjs": minor
"@statewalker/webrun-streams-livekit": minor
"@statewalker/webrun-streams-signaling": minor
"@statewalker/webrun-rpc": minor
---

One pipe module behind the four `messageTargetOver*` adapters (#151).

- `@statewalker/webrun-streams` adds `newMessagePipe(transport, options)`. It owns the listener set, delivery that a faulty listener cannot stop, the pipe's life, the byte check on `postMessage`, the frame ceiling, `bufferedAmount` / `whenDrained` and `close()`. A transport supplies only `send`, its buffered bytes, its drain wait and its close.
- `messageTargetOverWebSocket`, `messageTargetOverPeerJs`, `messageTargetOverLiveKit` and `messageTargetOverByteChannel` are now built on it, and depend on `@statewalker/webrun-streams` at runtime. Each target now carries `closeSignal` and `maxMessageSize`. The WebSocket and byte-channel adapters gain an optional `maxFrameBytes` (unset by default, as before), and the WebSocket adapter an optional `maxMessageSize`.
- `@statewalker/webrun-rpc`'s `overPipe` takes `signal` and `maxMessageSize` from the pipe's own `closeSignal` and `maxMessageSize` when they are not given, so `overPipe(target, { codec, side })` is enough.
- `@statewalker/webrun-streams-conformance` adds `describeMessagePipe`, the pipe contract suite. It runs against an in-memory transport and against each adapter.

Existing call sites keep working: adapters still return `{ target, signal, maxMessageSize }`.
