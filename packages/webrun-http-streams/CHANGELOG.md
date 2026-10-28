# @statewalker/webrun-http-streams

## 0.3.0

### Minor Changes

- ba6ae47: Abandoning a response releases the producer. Leaving `httpFetch`'s body before its end (an aborted `fetch`, a cancelled `Response` stream, a `break`) now returns the call's output generator, so the handler's stream is cancelled and its `finally` runs; before, `.return()` on the body never reached the call. `HttpFetchResult` gains `release()` for a caller that never reads the body (`fetchOverDuplex` uses it for bodyless responses, closing its "known gap"), and `HttpDataHandlerResult` an optional `release` that `httpServe` calls when the response is abandoned before the codec started reading the body (`serveFetchOverDuplex` cancels the `Response` body there).

## 0.2.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.2.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

## 0.2.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
