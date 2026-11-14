---
"@statewalker/webrun-http-proxy": patch
---

Proxied responses no longer carry the upstream's `content-encoding` and `content-length` once
`fetch` has decoded the body (`gzip`, `deflate`, `br`). A `zstd` body, which some runtimes' `fetch`
decodes (Node 24) and others do not (Node 22), is checked for the zstd magic number and labelled by
what was actually handed over. The caller's `accept-encoding` is narrowed to `gzip`, `deflate` and
`br` so the upstream is not invited to send `zstd` at all. Hop-by-hop response headers (and those the
response's `Connection` header names) are dropped. A client served through a Node adapter no
longer waits for missing bytes or tries to gunzip plain text.
