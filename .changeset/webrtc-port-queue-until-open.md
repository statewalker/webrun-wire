---
"@statewalker/webrun-streams-webrtc": patch
---

`webrtcPortMux`: a message posted on a port whose data channel is still connecting is now queued and sent, in order, when the channel opens, as a `MessagePort` queues it. Before, it was dropped without any error. A message over `maxFrameBytes` still throws `RangeError` at once, and a channel that closes before it opens drops the queue and aborts the port's `closeSignal`.
