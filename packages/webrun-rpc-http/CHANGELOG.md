# @statewalker/webrun-rpc-http

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [10c546a]
  - @statewalker/webrun-streams@0.7.0

## 0.5.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.1 -> ^0.6.2

## 0.5.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.6.0 -> ^0.6.1

## 0.5.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [d9dc580]
  - @statewalker/webrun-streams@0.6.0

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [e29084d]
- Updated dependencies [a3429b4]
- Updated dependencies [98242dc]
- Updated dependencies [e4e6228]
  - @statewalker/webrun-streams@0.5.0

## 0.3.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- 92a3399: `newRpcClient` no longer caches a failed descriptor load: if the server is not reachable at the
  first `loadService`, the next call fetches the descriptor again instead of rethrowing the first
  error for the life of the client.
- 92a3399: Security: a GET query string can no longer write to `Object.prototype`. Dotted query keys with a
  `__proto__`, `constructor` or `prototype` segment (`?__proto__.x=…`) are ignored. The service and
  method maps are prototype-less, so `constructor`, `toString`, `__proto__` and the like are never
  endpoints or services; an unknown service or method now answers `404` (was `500`), with the same
  `Method <m> not found in service <s>` error body.
- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
- Updated dependencies [cb56b7d]
  - @statewalker/webrun-streams@0.4.0

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams crosses a breaking line

### Patch Changes

- Updated dependencies [e5e180b]
  - @statewalker/webrun-streams@0.3.0

## 0.1.7

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

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
