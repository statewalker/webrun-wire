# @statewalker/webrun-site-builder

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
