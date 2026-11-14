---
"@statewalker/webrun-streams-signaling": patch
---

`QrSignaling.offer()` no longer starts the connection timeout at offer time. The 30 s `connectionTimeout` ran while people scanned the two QR codes, so a slower exchange made `accept()` return an already-rejected channel, and until `accept()` was called that rejection was unhandled. The timeout now starts in `accept()`, which also closes the connection and rejects if the answer cannot be applied.
