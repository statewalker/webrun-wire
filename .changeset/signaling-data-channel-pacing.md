---
"@statewalker/webrun-streams-signaling": minor
---

Channels over a data channel end instead of losing messages silently, and the port stack can pace them. `byteChannelFromDataChannel` ends the channel on a non-byte message (it threw inside the listener, dropping the message, so a call waited for ever) and on a `send` that throws (Chrome's full send queue was silent loss). `ByteChannel` gains optional `bufferedAmount` / `whenDrained()`; `byteChannelFromDataChannel` provides them from the data channel, and `messageTargetOverByteChannel`'s `target` exposes them, as the ws, peerjs, livekit and webrtc adapters do, so `overPipe` with `frameSize` waits for the transport. New export `DRAIN_LOW_WATER` (256 KiB).
