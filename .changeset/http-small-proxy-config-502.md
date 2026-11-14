---
"@statewalker/webrun-http-proxy": patch
---

An invalid `base`, a `headers` or `credential()` value that is not a valid header value, or a
`credential()` that throws now answers `502` with `x-webrun-proxy: upstream-unreachable` instead
of rejecting the returned promise. The underlying message is not echoed, since it can quote the
credential.
