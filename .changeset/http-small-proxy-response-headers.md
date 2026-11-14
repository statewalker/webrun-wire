---
"@statewalker/webrun-http-proxy": patch
---

Proxied responses no longer carry the upstream's `content-encoding` and `content-length` once
`fetch` has decoded the body (`gzip`, `deflate`, `br`, `zstd`), and hop-by-hop response headers
(and those the response's `Connection` header names) are dropped. A client served through a Node
adapter no longer waits for missing bytes or tries to gunzip plain text.
