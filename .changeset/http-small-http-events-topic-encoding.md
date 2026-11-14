---
"@statewalker/webrun-http-events": patch
---

Topics that need percent-encoding now work. The client percent-encodes only what the URL parser
would mangle (`%`, `/`, `?`, `#`, a space and other characters not valid in a path segment) and
the handler decodes the segment, so `my topic`, `a/b` or `what?` reach their subscribers and match
a `topics` allow-list. A segment with a malformed escape answers `404 no such topic`.

Every other topic keeps its old wire form (`user:42` is still `/user:42`), so a new client and an
old handler, or the reverse, still agree on it. Topics containing `%`, `/`, `?`, `#` or spaces were
broken before; for those, upgrade both the client and the handler.
