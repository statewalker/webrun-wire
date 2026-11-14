---
"@statewalker/webrun-http-proxy": minor
---

**Behaviour change: cookies are no longer forwarded by default.** `urlUpstream` now drops the
caller's `cookie` request header and the upstream's `set-cookie` response header, so the proxy
origin's session cookies do not reach a third-party upstream and the upstream cannot plant cookies
on the proxy's origin. Pass the new option `forwardCookies: true` to keep the old behaviour.

Also: a real `3xx` redirect (`301`, `302`, `303`, `307`, `308`), as Node and Deno return it under
`redirect: "manual"`, now answers `502` with `x-webrun-proxy: upstream-redirect`, the same as a
browser's opaque redirect, instead of passing the upstream's absolute `Location` to the caller.
`304` and other non-redirect `3xx` statuses pass through. Request headers named in a `Connection`
header are dropped too (RFC 9110 §7.6.1).
