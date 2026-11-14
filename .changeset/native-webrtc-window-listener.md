---
"@statewalker/webrun-streams-webrtc": patch
---

`connect()`'s `close()` removes the `connectionstatechange` listener it added to the peer connection, so repeated `connect()` calls no longer accumulate listeners. The receiver now enforces `RECEIVE_WINDOW`: a peer that ignores credit and sends past the window fails the call (queued payload dropped, channel closed) instead of growing the inbound queue without bound (#148).
