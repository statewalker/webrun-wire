---
"@statewalker/webrun-streams-webrtc": patch
---

`connect` / `serve`: a responder no longer loses its first frames in Chromium (statewalker/statewalker-root#51). When the caller's `open` event came before the responder's `datachannel` event, Chromium could drop what the responder sent before the caller's first frame reached it: a handler that failed at once lost its `ERROR`, and the caller waited for ever. The caller now sends a `HELLO` frame (0x04, ignored by every receiver) as soon as its channel opens, and the responder sends nothing before a frame of the caller's arrived, or `HELLO_FALLBACK_MS` (250 ms) for an older caller. Wire-compatible both ways.
