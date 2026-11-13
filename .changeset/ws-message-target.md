---
"@statewalker/webrun-streams-ws": patch
---

New `messageTargetOverWebSocket(ws)` and `openWebSocket(params)`: a WebSocket as a pipe of bytes for `webrun-rpc`'s port stack (Plan C2). `messageTargetOverWebSocket` returns `{ target, signal }`. `target` is a `MessageTarget` of bytes, one message each, with `bufferedAmount` and `whenDrained()`. `signal` aborts when the socket closes. Pass both to `overPipe` with `msgpackCodec`, and `webrun-rpc`'s `connect` / `serve` run one call per port, so a producer stays at most one chunk ahead of its consumer. A socket on `binaryType` "blob" or "fragments" is switched to "arraybuffer"; a message of any other kind ends the pipe with a `TypeError` rather than being dropped. `whenDrained()` resolves at `DRAIN_LOW_WATER` (256 KiB). `WebSocketLike` gains the optional `bufferedAmount` and `binaryType`.
