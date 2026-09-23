---
"@statewalker/webrun-site-host": minor
"@statewalker/webrun-site-builder": minor
---

Widen the `@statewalker/webrun-files` peer range to `^0.9.0 || ^0.10.0`.

Both packages pinned `peer @statewalker/webrun-files@^0.9.0`, which excludes
the current 0.10.0 release. A consumer installing `webrun-site-host` (which
depends on `webrun-site-builder`) alongside the current `webrun-files`
release hit `npm error ERESOLVE unable to resolve dependency tree`; the
range now admits both. Adds a consumer-install test harness
(`tools/consumer-install`) that packs each package as an external npm
consumer would and would have caught this.
