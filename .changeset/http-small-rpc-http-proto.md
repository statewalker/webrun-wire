---
"@statewalker/webrun-rpc-http": patch
---

Security: a GET query string can no longer write to `Object.prototype`. Dotted query keys with a
`__proto__`, `constructor` or `prototype` segment (`?__proto__.x=…`) are ignored. The service and
method maps are prototype-less, so `constructor`, `toString`, `__proto__` and the like are never
endpoints or services; an unknown service or method now answers `404` (was `500`), with the same
`Method <m> not found in service <s>` error body.
