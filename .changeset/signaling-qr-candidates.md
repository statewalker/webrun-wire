---
"@statewalker/webrun-streams-signaling": patch
---

QR payloads keep what a candidate needs. `compressCandidate` dropped `raddr` / `rport` / `tcptype`, producing invalid TCP candidates; such a candidate now goes in the existing raw `R:` form with just those attributes. An `sdpMLineIndex` of 0 in a raw candidate no longer comes back as null, and a null one travels as an empty field. Payloads stay readable by older versions.
