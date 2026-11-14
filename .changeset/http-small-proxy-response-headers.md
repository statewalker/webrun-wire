---
"@statewalker/webrun-http-proxy": patch
---

Proxied responses no longer carry the upstream's `content-encoding` and `content-length` once
`fetch` has decoded the body (`gzip`, `deflate`, `br`). A `zstd` body, which Node 22's `fetch` does
not decode, keeps its headers, and the caller's `accept-encoding` is narrowed to the codings `fetch`
decodes so the upstream is not invited to send one. Hop-by-hop response headers (and those the
response's `Connection` header names) are dropped. A client served through a Node adapter no
longer waits for missing bytes or tries to gunzip plain text.
