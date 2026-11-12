---
"@statewalker/webrun-streams-ws": patch
---

New `messageTargetOverWebSocket(ws)` and `openWebSocket(params)`: a WebSocket as a pipe of bytes for `webrun-rpc`'s port stack (Plan C2). `messageTargetOverWebSocket` returns `{ target, signal }`. `target` is a `MessageTarget` of bytes, one message each, with `bufferedAmount` and `whenDrained()`. `signal` aborts when the socket closes. Pass both to `overPipe` with `msgpackCodec`, and `webrun-rpc`'s `connect` / `serve` run one call per port, so a producer stays at most one chunk ahead of its consumer. `connect` / `serve` over `emulateMux` are unchanged, and both conformance runs pass. `WebSocketLike` gains the optional `bufferedAmount` and `binaryType`.
