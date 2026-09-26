# @statewalker/webrun-site-builder

## 0.2.0

### Minor Changes

- 89922b5: Widen the `@statewalker/webrun-files` peer range to `^0.9.0 || ^0.10.0`.

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

## 0.1.2

### Patch Changes

- Republish so the peer range on disk is the one npm serves.

  `0.1.1` is already on npm, and its `dist/` is byte-identical to what this tree
  builds — but the published `package.json` declares
  `@statewalker/webrun-files: ^0.7.0` where this one declares `^0.9.0`. Same
  version number, different dependency contract, which is the drift the release
  plan's Step 2 exists to catch.

  It matters because `webrun-site-host` depends on this package, and a consumer
  installing the new site-host would resolve to the published `0.1.1` and its
  `^0.7.0` peer — an ERESOLVE against the 0.9.x line every other package in this
  release moves to. `changeset publish` skips a version that already exists, so
  without a bump npm would keep serving the stale contract indefinitely.

  No code change: this is the version bump that lets correct metadata ship.

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
