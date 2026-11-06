---
"@statewalker/webrun-streams-libp2p": minor
---

A dead peer fails a call instead of hanging it or ending it cleanly.

- A call's output throws `PeerGoneError` when the stream ends before both sides finished it (the peer died, the connection dropped, or a reset after the peer's side ended). A clean end now requires the peer's own close-write, so a truncated response no longer reads as a complete one.
- A call whose input is still open no longer waits for that input once the stream is dead.
- New `messageTargetOverStream(stream)`: one stream as a message pipe for `multiplexPort` / `overPipe`, with a `signal` that closes the multiplexer when the stream or its connection dies.
- The target delivers every message the peer sent before `signal` aborts, aborts the stream on a malformed length or one past `maxMessageBytes` (default 64 MiB), and reports `bufferedAmount` (the stream's write buffer) and `whenDrained()` (libp2p's `drain`, or `close`).
- A serving side no longer logs a caller that sent its whole request and then stopped reading the response.
