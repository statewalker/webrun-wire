---
"@statewalker/webrun-streams-libp2p": patch
---

`messageTargetOverStream`'s `postMessage` throws `TypeError` for anything but bytes (`Uint8Array`, `ArrayBuffer` or a view), as the other adapters' byte pipes do, instead of sending an empty frame (#148).
