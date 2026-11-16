---
"@statewalker/webrun-streams": patch
---

Windowed native ports (`newNativePortMux` with `window`, under `libp2pPortMux` and `webrtcPortMux`) close two remaining bounds of the #195 class:

- The inbound window is now enforced at the mux, not only in webrun-rpc's stream tier (#197): a peer whose unconsumed messages pass both the window this end grants and the message that just arrived (it ignored the window) gets its port failed with "the peer sent past the window". A consumer that uses a windowed native port directly, with a slow async listener, holds at most about one window of such a peer. Honest peers never trigger it. A WebRTC opener posting directly to a native port must not post more than the peer's window before the peer's `hello` arrives (the stream tier never does). Likewise, a direct user who closes a port with messages still queued sends them past the window, and a receiver with a slow listener may then fail the port (#208; the stream tier waits for its queue before closing).
- A write that waits for the peer's credit longer than `drainTimeoutMs` now fails the port, as a write waiting for drain already did (#201). A caller that takes a response and never reads it no longer parks the server's handler for ever. Credit that arrives restarts the bound; a quiet port, with nothing queued, is never timed out.
