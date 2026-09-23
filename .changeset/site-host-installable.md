---
"@statewalker/webrun-site-host": minor
"@statewalker/webrun-site-builder": minor
---

Widen the `@statewalker/webrun-files` peer range to `^0.9.0 || ^0.10.0`.

Both packages pinned `peer @statewalker/webrun-files@^0.9.0`, which excludes the
current 0.10.0 release: `npm i @statewalker/webrun-site-host
@statewalker/webrun-files@0.10.0` failed outright with `npm error ERESOLVE unable
to resolve dependency tree`. The range now admits both releases, so that install
succeeds.

Adds a consumer-install test harness (`tools/consumer-install`) that packs each
package plus its transitive workspace-dependency closure, installs the tarballs
as an external npm consumer would, imports every declared export subpath under
plain Node, and checks every file the published exports map names actually ships.

**Known remaining caveat — this changeset does not fix it.** `webrun-site-host`
still declares a runtime dependency `@statewalker/webrun-files-mem: "catalog:"`,
which the catalog resolves to `^0.9.0`; `@statewalker/webrun-files-mem@0.9.0` in
turn hard-pins `@statewalker/webrun-files` at exactly `0.9.0`. So installing
`webrun-site-host` alongside `webrun-files@0.10.0` now produces no ERESOLVE, but
npm nests a second copy of `webrun-files@0.9.0` under `webrun-files-mem` — which
defeats the single-shared-instance guarantee the peer dependency exists to
express. Bumping the catalog entry (and republishing `webrun-files-mem` against a
range rather than a pin) is a separate decision, tracked separately.
