---
"@statewalker/webrun-streams": patch
"@statewalker/webrun-streams-webrtc": patch
---

A WebRTC port no longer loses what the peer sends as soon as its data channel opens (a regression from #152, not yet released). A `NativeChannel` may now carry `ready`: `newNativePortMux` builds the port, which starts listening and holding messages, before it waits for the channel to open, as `webrtcPortMux` did before #152.
