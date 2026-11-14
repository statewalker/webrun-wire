---
"@statewalker/webrun-streams-signaling": minor
---

`PeerManager` no longer leaves failures as unhandled rejections, and forgets failed connections. A signal a connection rejects (an offer during glare, malformed SDP or candidates) and an inbound connection whose channel never opens now close and forget the connection and are reported through the new optional `onError(error, peerId)` option; a failed `connect()` rejects and forgets its connection. A connection whose state becomes `failed` or `closed` is forgotten too, and a new offer from a peer replaces the connection that answered its previous one, so the peer can reconnect. `PeerConnection.open()` rejects when the connection is closed before the channel opens.
