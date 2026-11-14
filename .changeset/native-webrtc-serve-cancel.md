---
"@statewalker/webrun-streams-webrtc": patch
---

`serve`: a handler that reads its input no longer hangs when the caller cancels or the caller's input throws. The handler's input now ends with the error (its next read throws it instead of reporting a clean end) before the responder waits for its outbound pump, so the handler's `finally` runs (#124).
