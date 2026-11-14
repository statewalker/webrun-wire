---
"@statewalker/webrun-streams-libp2p": minor
---

`duplexOverStream` (and so `connect` / `serve`): the frame parser now caps a frame's payload with a new `maxFrameBytes` option (default `DEFAULT_MAX_FRAME_BYTES`, 64 MiB, newly exported), reassembles frames in a doubling buffer instead of re-copying the whole buffer per incoming piece, and fails the call and aborts the stream on a malformed frame length instead of buffering for ever. Outbound producer chunks larger than 64 KiB are sent as several frames; frames are self-delimiting, so older receivers reassemble the same bytes (#125).
