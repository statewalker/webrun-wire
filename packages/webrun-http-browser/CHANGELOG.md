# @statewalker/webrun-http-browser

## 0.6.0

### Minor Changes

- 8b789ef: Relay services can be mounted at a path, including the origin root, with keys
  and paths chosen by the host and carried on REGISTER. Several services can
  share one relay connection: a CONNECT is routed to the service named by its
  key, so an app at `/` and a gateway at `/peers/` can register over the same
  port without answering each other's calls. Routing is by longest matching
  prefix, and the matched prefix is NOT stripped — a handler mounted at
  `/peers/` receives `/peers/…`.

  A request matching no mount is not the relay's: the worker does not call
  `respondWith` for it at all, so the browser performs it exactly as it would
  with no worker installed, and a host keeps serving its own files. (Requests
  arriving in the moment before the registry has been read back are the one
  exception: the table cannot be consulted synchronously yet, so they are
  claimed and re-issued.) `exclude` reserves paths from a root mount — and from
  the `/~<key>/` spelling too — and must also cover the host's own entry page,
  not just the relay page and worker script, or a reload cannot get past a root
  mount.

  A mount declared in `mounts` belongs to the host: a page's REGISTER or
  UNREGISTER naming the same key never replaces or removes it, so the page can
  register with no `path` of its own. A mount an earlier REGISTER created is
  still replaced by a path-ful REGISTER and removed by a path-less one.

  New: `@statewalker/webrun-http-browser/relay-worker`, the relay worker
  runtime as a typed ES module — `startRelayServiceWorker`, with
  `RelayServiceWorkerOptions` and `MountSpec` — for a host that bundles its own
  worker, and for typing `self.RELAY_OPTIONS`. The prebuilt `dist/relay-sw.js`
  still reads its options from `self.RELAY_OPTIONS`, set by the host's own
  worker script before `importScripts`, since a classic worker cannot otherwise
  receive arguments. New options: `mounts`, `exclude`, `canRegister`,
  `takeover`, `decorateResponse`. Mounting at `/` should be paired with
  `takeover: "first-wins"` and `canRegister`.

  Fixes: `splitServiceUrl` treated any URL containing `~` as a service URL,
  including `?q=~foo`; it is now anchored to the pathname, and it still splits
  root-relative input (`/~FS/a/b`), which anchoring had broken. Registrations
  record `{ clientId, path }`, and the earlier bare-client-id shape is still
  read, so a returning visitor's services survive. A connection carrying more
  than one registered service had every `CONNECT` answered by every service,
  colliding on the same transferred port; a `CONNECT` is now delivered only to
  the service named by its key.

## 0.5.0

### Minor Changes

- 8bf5ee6: Never hang when the page is not controlled by its ServiceWorker.

  `SwHttpAdapter.start()` and the relay page's `initServiceWorker` waited for
  `navigator.serviceWorker.controller` with no bound, resolving only on
  `controllerchange`. A page that loads uncontrolled while its worker is already
  active — a hard reload (Ctrl+Shift+R), which bypasses the worker for that load
  after its `clients.claim()` has long run; or a page Firefox leaves uncontrolled —
  never gets that event, so `start()` hung forever.

  - Same-origin mode (`SwHttpAdapter.start()`): an uncontrolled page asks its
    worker to claim it (a new `CLAIM` channel call, which both bundled workers
    answer with `clients.claim()`) and waits for `controllerchange`. Verified in
    Chromium and Firefox to take over a hard-reloaded page.
  - Relay mode (`initServiceWorker`, `getRelayWindowMessageHandler`): the relay
    only messages its worker, so an uncontrolled relay page bridges to
    `registration.active` instead of waiting for control. A relay that cannot
    start answers the parent's calls with the error instead of leaving them
    unanswered.
  - Every wait is bounded: new `timeout` option (default 30 s) on
    `SwHttpAdapter`/`SwPortHandler`, `initServiceWorker` and
    `getRelayWindowMessageHandler`. Past it, or when the page stays uncontrolled,
    the promise rejects with a `ServiceWorkerControlError`
    (`reason: "activation-timeout" | "uncontrolled" | "unresponsive"`) whose
    message says what happened and what to do. A failed `start()` can be retried.
  - New opt-in `reloadIfUncontrolled` option on `SwHttpAdapter`: reload once
    instead of rejecting, guarded by `sessionStorage` so it cannot loop.
  - New exports: `awaitServiceWorkerControl`, `awaitActiveServiceWorker`,
    `handleClaimRequests` (for a worker script of your own),
    `ServiceWorkerControlError`, `DEFAULT_SERVICE_WORKER_TIMEOUT`, `CLAIM_CALL`;
    `newServiceWorkerPort` takes an optional registration.
  - Vite consumers of the root entry no longer emit a dead ~91 KB copy of
    `dist/index.js`: the relay defaults no longer use the literal
    `new URL("../", import.meta.url)` pattern that Vite turns into an asset.

## 0.4.2

### Patch Changes

- Updated dependencies [fbaee6a]
  - @statewalker/webrun-rpc@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [0e435d6]
  - @statewalker/webrun-rpc@0.3.0

## 0.4.0

### Minor Changes

- ff650fc: Replace stop-and-wait flow control with credit-based flow control in `emulateMux`.

  **Wire format changed and is incompatible with peers predating this release.**
  OPEN and ACK frames now carry a uint32 credit payload. A peer running the old
  protocol cannot interoperate with one running this version; both sides of a
  connection must be upgraded together. `emulateMux` now costs one additional
  round trip per stream at open time, to establish the initial credit window.

  Every package that embeds `emulateMux` is bumped explicitly here — rather than
  left to the automatic "dependent" bump — because a dependent-only changelog
  entry does not mention a protocol break, and consumers need to see one:
  `@statewalker/webrun-rpc` (renamed from `@statewalker/webrun-streams-port`),
  `@statewalker/webrun-streams-ws`,
  `@statewalker/webrun-streams-peerjs`, and `@statewalker/webrun-streams-livekit`
  all embed the new wire format and gain a `mux` parameter on their connection
  params (`PortParams`, `ConnectWsParams`/`ServeWsParams`, and the peerjs/livekit
  equivalents). `@statewalker/webrun-streams-webrtc` and
  `@statewalker/webrun-streams-libp2p` multiplex natively and are unaffected;
  they still pick up the automatic dependent bump from
  `updateInternalDependencies: "minor"`.

  `@statewalker/webrun-streams` itself adds new exports (`newCreditLedger`,
  `CreditLedger`, `newCreditGrantor`, `CreditGrantor`) and two smaller behavior
  changes on the same minor: `emulateMux` now throws `RangeError` for
  `maxStreamBuffer < 1`, where it previously accepted it silently, and a
  window above `2^32 - 1` is now advertised as `2^32 - 1` instead of wrapping.

  `@statewalker/webrun-streams-conformance`'s `MakePair` gains a parameter, and
  adds a new L6 conformance level.

  `@statewalker/webrun-http-browser` is bumped explicitly rather than left to
  the dependent bump: `src/core/index.ts` re-exports
  `@statewalker/webrun-streams` in full (`export * from "@statewalker/webrun-streams"`),
  so the four new credit-ledger exports above, plus Task 6's four
  `MessageTarget` types, become public exports of this package too.

  The RPC tier (`webrun-rpc`'s send/receive) is unchanged here; its move from
  `webrun-streams-port` and its retyping to accept any `MessageTarget` are
  credited separately, in the `port-layer-to-webrun-rpc` changeset.

### Patch Changes

- 2291ab3: Cancellation now reaches the producer, across every adapter.

  Nine defects, found by putting one unchanged HTTP site in front of a real
  Chromium and measuring what happened when a caller walked away. They formed a
  chain — each one hid the next, so none could be fixed alone.

  **Teardown that never reached the producer.** `duplexOverStream` awaited a
  `.return()` that is queued behind a pending `next()`, so it hung for ever;
  `emulateMux`'s outbound pump checked `closed` only _after_ a chunk arrived, so
  the producer leaked. Both acquire the iterator once and cancel without awaiting
  now. `framedOutbound` also stopped telling a _server's_ handler that its caller
  had gone — a regression introduced while fixing the first two, and caught by a
  test rather than by review.

  **Cancellation that stopped at the adapter.** `toReadableStream` had no `cancel`
  at all, so a cancelled response body never released the iterator feeding it; it
  also drained its whole source inside a single `pull`, which defeated the
  stream's own backpressure and left no point between chunks at which a
  cancellation could take effect. `fromReadableStream` never released its reader,
  so an early exit — `break`, `.return()`, an error — left the source stream
  uncancelled and its producer running. Between them they broke every abort path
  in the repo.

  **A transport with no cancellation message.** Closing a `MessagePort` does not
  notify its peer, so the ServiceWorker HTTP transport's teardown was invisible on
  the far side and a browser handler kept producing for the life of the page after
  its caller had gone. It sends one now, and the receiving channel releases what
  it is sending — without awaiting, because `.return()` on a parked generator is
  queued behind its own pending `next()`.

  **A worker url that could not be relative.** `new URL("/sw-worker.js")` with no
  base throws `Invalid URL` from a _constructor_, naming neither the option nor
  the value. A worker url is relative to the document that registers it, so it is
  resolved against `location.href` now.

  **A port stack that only accepted `MessagePort`.** `PortParams.port` and
  `byteChannelFromMessagePort` were narrowed to `MessagePort` though neither uses
  more than the `MessageTarget` surface they are otherwise written against. The
  narrowing shut out every virtual port — including one backed by a libp2p stream,
  which is how a mesh hands out ports at all. Found by `tsc`.

  A ServiceWorker _is_ told when its client aborts: `request.signal` never fires
  in Chromium, but the `ReadableStream` given to `respondWith` has its `cancel()`
  invoked. That measurement is what established these as transport defects rather
  than a platform limit, and it was taken with none of the code under suspicion.

  Regression tests live beside each fix: `readable-streams-cancel.test.ts`,
  `emulate-mux-cancel-input.test.ts`, `cancel-open-input.test.ts`,
  `cancel-server-handler.test.ts`, `http-cancel.test.ts` (which reproduces the
  browser leak with two plain `MessagePort`s and no ServiceWorker), and
  `sw-worker-url.test.ts`.

  Backpressure on the deprecated ServiceWorker transport is untouched and its
  deprecation note remains true: `sendStream`'s chunk sender still discards the
  promise it is given.

- c6dc18d: The port layer moves to `@statewalker/webrun-rpc`, renamed from
  `@statewalker/webrun-streams-port`.

  **Both packages are still on 0.x, where `minor` is the breaking channel, so
  these are declared `minor` and land as 0.2.0 — not `major`, which changesets
  would take straight to 1.0.0. The changes below are breaking regardless of the
  bump level; read them as such.**

  `webrun-rpc` breaks twice over: the npm package name changed, and `openPort`
  is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
  `structuredCodec` and the port envelope types, and its RPC primitives —
  `callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
  `send`, `recieve` — now accept any `MessageTarget` rather than only a
  `MessagePort`.

  `webrun-streams` breaks because it loses those exports. It keeps generic
  stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
  async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
  consumes it and touches nothing port-related.

  `webrun-http-browser` only repoints a one-line re-export, so it is a patch.

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [3c0f98a]
- Updated dependencies [c6dc18d]
- Updated dependencies [4f958b9]
  - @statewalker/webrun-streams@0.2.0
  - @statewalker/webrun-rpc@0.2.0
  - @statewalker/webrun-http-streams@0.2.2

## 0.3.4

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-http-streams@0.2.1
  - @statewalker/webrun-streams@0.1.1
