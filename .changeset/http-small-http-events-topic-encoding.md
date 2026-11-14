---
"@statewalker/webrun-http-events": patch
---

Topics that need percent-encoding now work: the client percent-encodes the topic into one path
segment and the handler decodes it, so `my topic`, `a/b` or `what?` reach their subscribers and
match a `topics` allow-list. A segment with a malformed escape answers `404 no such topic`.
