---
"@statewalker/webrun-http-events": patch
---

Stop shipping the unit tests to npm: they moved from `src/` to `tests/`. The package's tsconfig
now extends the repository's `tsconfig.base.json`, and a `lint` script was added.
