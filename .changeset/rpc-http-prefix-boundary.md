---
"@statewalker/webrun-rpc-http": patch
---

`newRpcServer`'s `path` prefix matches whole path segments: with `path: "/api/v1"`,
`/api/v1x/math` now gets `404 Not found` instead of being served as `/api/v1/`.
