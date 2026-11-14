---
"@statewalker/webrun-streams-signaling": minor
---

`byteChannelFromRoom` now follows `webrun-streams-livekit`'s conventions instead of duplicating its older behaviour. Its packets carry a topic (`options.topic`, default `DEFAULT_ROOM_TOPIC`, `"webrun/port-stack"`) and packets on any other topic are ignored, so another pipe's packets in the same room no longer leak in. Closing one end publishes a goodbye on `<topic>/close`, so the peer's channel ends while the room stays connected. A `send` past `options.maxFrameBytes` (default `DEFAULT_ROOM_MAX_FRAME_BYTES`, 64 000) ends the channel and throws `RangeError`. It also reports `bufferedAmount` / `whenDrained()`. `RoomManager.channelTo(peerId, options?)` passes the options through. Packets now carry a topic, so both ends must upgrade together: an older end's untopiced packets are ignored.
