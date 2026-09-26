# @statewalker/webrun-site-host

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

### Patch Changes

- Updated dependencies [89922b5]
  - @statewalker/webrun-site-builder@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [8b789ef]
  - @statewalker/webrun-http-browser@0.6.0

## 0.1.6

### Patch Changes

- Updated dependencies [8bf5ee6]
  - @statewalker/webrun-http-browser@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-site-builder@0.1.2

## 0.1.4

### Patch Changes

- @statewalker/webrun-http-browser@0.4.2

## 0.1.3

### Patch Changes

- @statewalker/webrun-http-browser@0.4.1

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-http-browser@0.4.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-http-browser@0.3.4
  - @statewalker/webrun-site-builder@0.1.1
