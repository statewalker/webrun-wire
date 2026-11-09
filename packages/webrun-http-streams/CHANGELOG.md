# @statewalker/webrun-http-streams

## 0.4.2

### Patch Changes

- ce6a29b: Types only, no runtime change: the generator wrappers behind `returningAtOnce` (webrun-rpc) and an `httpServe` handler's body (webrun-http-streams) typecheck with Node's types too, where `AsyncGenerator` requires `Symbol.asyncDispose` (they add it where the runtime has it). The shipped `src/` changes; `dist/*.js` does not.

## 0.4.1

### Patch Changes

- 1e8e15d: An abort of a request's signal reaches its response body even after the caller has let the `Request` go. In Node, a `Request`'s signal follows the caller's signal only while the `Request` lives (undici holds the Request's controller through a WeakRef), so a caller that kept only the `Response` could abort, and the body (from `fetchOverDuplex`, or an HTTP link's `send`) never saw it: the read went on, and the call, its port and the link's `inflight` stayed taken. The response body now holds its `Request` until it ends, and lets it go then; a call that is finished but not yet ended by the peer holds it until the call ends, so an abort can still abandon it (`HttpDataOptions.keepAlive`, which `fetchOverDuplex` sets). `WorkerHttpService.fetch(request, init)` passes the request's signal on explicitly.

## 0.4.0

### Minor Changes

- 12048dd: A `Request` served by `serveFetchOverDuplex` now has a `signal` that aborts when the exchange is abandoned before it is over: the caller left or its transport went away, or the serving side tore the stream down. A handler waiting before it answers, such as a long poll, can stop. A completed exchange never aborts. `newHttpServerStub` requests do not carry it.
  
  `httpServe` handlers get the signal as a third argument, `exchange.signal` (new type `HttpExchange`); the abort reason's message is the new export `EXCHANGE_ABANDONED_MESSAGE`, or the reason is the error itself when the stream was thrown into.
  
  Breaking: `HttpDataHandler`'s third argument `exchange: HttpExchange` is required. Handlers written with two parameters still type-check, but code that invokes an `HttpDataHandler` itself must pass one.

## 0.3.2

### Patch Changes

- 29cba96: An abort of a request's signal ends its response body at once, whether a read is waiting or not. `fetchOverDuplex` used to look at the signal only when the next chunk arrived, so a read waiting on a peer that sent nothing more hung, and an unread body kept its call (on a multiplexed link, its port) until someone read it. Now the abort errors the body with the abort's reason, rejects a waiting read, and abandons the call. A link's `inflight` count and `whenIdle()` drop the request at the abort too. The listener on the signal is removed once the body ends, however it ends. A body cancelled while a read waits on a quiet peer no longer keeps its call (and its port) open for good: the read in flight decides. If it brings the body's end, the call is finished as for a body read to its end, so an upload the handler reads after answering goes on; otherwise the call is abandoned, after at most 1 s when the peer sends nothing more. `cancel()` does not wait for either.

## 0.3.1

### Patch Changes

- a7d06aa: `httpFetch` (and so `fetchOverDuplex`) ends its call however the exchange ends. A response body read to its end left the call open, and on a multiplexed transport (webrun-rpc's `connect`) that kept one port per exchange: every GET or POST over one link held a port for good, and the link refused calls with `webrun-rpc: maxPorts (1024) reached` after 1024 of them.
  
  - A body read to its end, or a response with none (HEAD, 204, 304...), now reads the call to its end in the background (`HttpFetchResult.finish()`): the peer ends the call once its side of the exchange is over. A body left early abandons the call, as before, and so does an abort of the request's signal while the call is being read to its end. Against a peer that never ends a call (a socket that never reaches EOF), that abort is what ends it.
  - On the serving side, `serveFetchOverDuplex` ends its side once the response is out and the handler is done with the request body: a handler that answers first (`202`) and reads the upload afterwards gets all of it, as long as it keeps reading; a body it never took is cancelled, and one it took and stopped reading (a reader dropped, a clone nobody reads) is abandoned once nothing asked it for a chunk for `requestIdleMs` (a new option, default 30 s), its later reads failing. The time a handler spends on one chunk before it asks for the next counts as idle: one that pauses longer between reads needs a larger `requestIdleMs`. `HttpDataHandlerResult` takes the hook for that, `settled`; `release` is called only for a response abandoned before its end.
  - The call also ends when the response cannot be decoded, and when the request's signal aborts while the head is awaited: the exchange rejects with the signal's reason at once (it used to wait for the head). `HttpDataOptions` takes that `signal`.
  
  The module-level codec and constants are annotated pure, so a bundle that does not use the HTTP codec drops it.
- Updated dependencies [a7d06aa]
  - @statewalker/webrun-streams@0.2.3

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
