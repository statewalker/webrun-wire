# @statewalker/webrun-rpc-http

## 0.1.6

### Patch Changes

- ec75a83: `newRpcServer`'s `path` prefix matches whole path segments: with `path: "/api/v1"`,
  `/api/v1x/math` now gets `404 Not found` instead of being served as `/api/v1/`.

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
