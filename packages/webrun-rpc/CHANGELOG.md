# @statewalker/webrun-rpc

## 0.11.0

### Minor Changes

- e5e180b: **Breaking: `emulateMux` is removed (Plan C3).** Every transport now runs `webrun-rpc`'s port stack. Each adapter gives a pipe (`messageTargetOver…`), `overPipe` with `msgpackCodec` invents a port per call on it, and `webrun-rpc`'s `connect` / `serve` run one call per port. On that stack a producer stays at most one chunk ahead of its consumer; `emulateMux` buffered up to its 8 MiB window. The wire format changes, so both ends must upgrade together.
  
  - `webrun-streams`: `emulateMux`, `EmulateMuxOptions` and `ByteChannel` are gone. `newCreditLedger` / `newCreditGrantor` stay exported, dormant, as the mechanism for per-stream windowing (spec D13).
  - `webrun-streams-ws`, `-peerjs`, `-livekit`: the `emulateMux`-based `connect` / `serve` and `byteChannelFromWebSocket` / `byteChannelFromPeerJs` / `byteChannelFromLiveKit` are gone. Use `messageTargetOverWebSocket` / `messageTargetOverPeerJs` / `messageTargetOverLiveKit` with `overPipe` (see each README). None of the three has a runtime dependency left.
  - `webrun-rpc`: `byteChannelFromMessagePort` is gone; a `MessagePort` goes to `overPipe` directly.
  - `webrun-streams-signaling`: `ByteChannel` is now declared here, with the same shape, and the package has no runtime dependency. Import the type from this package instead of `webrun-streams`. New `messageTargetOverByteChannel(channel)` runs the port stack over a channel this package hands back, reporting 16 KiB − 256 as `maxMessageSize`.
  - `webrun-streams-conformance`: comments only. `PairTuning` is unchanged here, and every pair now ignores it until D17 redefines L6.
  - `webrun-http-streams`: comments only. Its peer-error slot test now runs on the port stack.
  
  `webrun-streams-signaling` also fixes `byteChannelFromRoom`, which never ended. It now closes when the room disconnects, when its participant leaves, or when a reliable publish fails, and it ignores packets that carry no participant. Before this, anything run over it (now the port stack) hung when the other end went away.
- 1758c6a: An exchange on a windowed `multiplexPort` port takes one round trip, in both directions, instead of two. The window handshake (`open`, the responder's zero-byte ack, the opener's answer to it) used to hold each end to confirmed calls until it had seen the other's step: a responder pipelined only 1.5 round trips after the port opened (a GET's body came a round trip after its head), and an opener only once the ack came back (a POST's end waited for its first chunk's confirmation). Nothing new goes on the wire; old and new peers interoperate in all four pairings.
  
  - **Responder:** it holds its own sends back by the window from the `open` on, without waiting for the opener's answer, when the `open` lists `caps` (only a mux that grants credit lists them, 0.9 and later, first published as 0.10) and this mux has already read a `credit` envelope on any port (which shows its own codec reads them; one that drops them keeps waiting for the answer, unwindowed, as before). It does not show that the opener's codec reads credit: an opener over a codec that drops credit on read never agrees `pipeline`, and its streams fail on the responder's first pipelined chunk ("pipelining was not agreed"), as with 0.10 on both ends once the opener's first grant arrives, but from the second port on at once. A 0.10 opener gets a GET's head and body together from its second port on.
  - **Opener:** new option `presumeAck` on `multiplexPort` / `overPipe`, `"learned"` (default), `"always"` or `"never"`. A presuming port takes the responder's ack as given when it opens: it holds back by the window at once, agrees `pipeline`, and posts its answer to the ack right behind the `open`, so a 0.10 responder pipelines from the start too. `"learned"` presumes, on every port after the first, the ack this peer already sent on an earlier port of the same mux, once one listed `pipeline`; `"always"` presumes from the first port, for a pipe whose peer is known to be 0.10 or later; `"never"` keeps the 0.10 behaviour. An ack that contradicts the presumption (other sizing, or no `pipeline`) stops presumption on that mux, and fails the port with reason `"protocol"` only if it already posted something. A port refused without an ack (`maxPorts`) or after one (`onPort`) closes as before, having sent at most one window, which the responder drops.
  
  Behaviour change: by default an opener now sends a stream's chunks before the ack from its second port on, so on a refused port it may send up to a window where it sent one chunk. On the opening side `ports()` still reports `window` only once the ack arrived; on the serving side it now reports it from the `open` on when the `open` lists `caps` and the mux has already read a `credit`. Set `presumeAck: "never"` for the previous timing on the opening side.

### Patch Changes

- 9ed3bc7: New `libp2pPortMux(options)` in `webrun-streams-libp2p`: native MessagePorts over libp2p. Each port is its own libp2p stream, multiplexed by yamux, framed by `messageTargetOverStream` and encoded by a value codec (`{ encode: serialize, decode: deserialize }` from `webrun-msgpack`). It is a `webrun-rpc` `PortMux` by shape: pass it to `overPorts`, and `webrun-rpc`'s `connect` / `serve` run each call on its own stream. The port stack's backpressure keeps a producer within one chunk of a consumer that stopped reading. With libp2p's own `connect` / `serve`, a producer gets tens of megabytes ahead and the stream is then aborted.
  
  Native ports and emulated ports (`overPipe` on one `messageTargetOverStream`) both pass the conformance suite with L6 at a one-chunk bound. A port carries `closeSignal`, so a call on a dead stream fails. Ports reuse `connect()`'s early-stream gate. The stream limits default to 1024, because every concurrent call is a stream and libp2p's own default of 32 would reset the 33rd. A refused port is aborted on both ends, and a call on it fails. An undecodable frame fails the port. The serving side gets `{ remotePeer, connection }`.
  
  `messageTargetOverStream` now aborts its `signal` for a stream that ended before it was attached, for example a peer that reset the stream during protocol negotiation. Before, that signal never aborted; it now aborts with `PeerGoneError`. Its target also carries `closeSignal`.
  
  `webrun-rpc`: `MessageTarget` gains the optional `closeSignal`, and `getPortCloseSignal` returns it when no signal was registered with `setPortCloseSignal`. A transport adapter can now supply a port's close signal by shape, without importing `webrun-rpc`.
  
  `webrun-rpc` also fixes a stream-tier bug. A port whose close signal had already aborted when `duplexOverPort` or `serveDuplexOverPort` got it left the stream waiting forever, because an `abort` listener added to an aborted signal never fires. A call on such a port now fails at once.
- 3166c3b: New `messageTargetOverPeerJs(conn)` and `messageTargetOverLiveKit(room, peerIdentity)`: a raw PeerJS connection, or one LiveKit participant, as a pipe of bytes for `webrun-rpc`'s port stack (Plan C2). Each returns `{ target, signal, maxMessageSize }`. `target` is a `MessageTarget` with `bufferedAmount` and `whenDrained()`. `signal` aborts when the transport goes. `maxMessageSize` is the payload ceiling to give `overPipe`: 16 KiB − 256 for PeerJS, 12 KiB for LiveKit.
  
  PeerJS's ceiling was measured first, as the spec required. Between two Chromiums, 256 KiB arrives and one byte more arrives as nothing, with the connection silently closed. Firefox to Chrome cuts off at 16 KiB. So a post past `maxFrameBytes` (16 KiB) ends the pipe with a `RangeError` rather than vanishing. The connection must be open, raw and reliable, and `close()` flushes before closing.
  
  LiveKit packets carry their own topic. Ending a pipe on one side sends a goodbye that ends the peer's pipe, because the room stays connected. The packet cap is livekit-client's own 64,000 bytes.
  
  `webrun-rpc`: `duplexOverPort` fits the error a stream ends with to `maxMessageSize` before sending it whole. In order, it drops the stack, then the largest extra fields, then the message's tail, and marks the error `truncated: true`. Before this, a large error message, or an error carrying an HTTP body, went out as one oversized message, which a transport with a ceiling drops or dies on.
- Updated dependencies [e5e180b]
  - @statewalker/webrun-streams@0.3.0

## 0.10.2

### Patch Changes

- ce6a29b: Types only, no runtime change: the generator wrappers behind `returningAtOnce` (webrun-rpc) and an `httpServe` handler's body (webrun-http-streams) typecheck with Node's types too, where `AsyncGenerator` requires `Symbol.asyncDispose` (they add it where the runtime has it). The shipped `src/` changes; `dist/*.js` does not.

## 0.10.1

### Patch Changes

- 3bb1254: A pipelined stream that waits on a full window no longer keeps memory per wait. Each wait raced the window against a promise for the stream's abort, which never settles on a live stream, so every wait left a reaction on it until the stream ended: with a 1 KiB window, 200,000 × 16 B chunks grew the heap by about 8 MB. Each wait now listens for the abort only while it lasts.

## 0.10.0

### Minor Changes

- c95cc50: Half-close on windowed ports. A windowed `open` now lists `caps: ["pipeline", "end"]`, `end` only when the mux's codec declares the new optional `PortCodec.halfClose: true` (that its `read` accepts the `end` envelope); `structuredCodec` and `msgpackCodec` set it. A codec without the flag never offers or agrees `end`, so a codec that would drop the envelope cannot leave a normally finished port in the peer's table. Where both ends agree `end`, each direction of a port can end with a new `{ type: "end", id }` envelope, queued behind everything already posted on that port (a size-0 item in its window queue, so it needs no credit, and behind its frames with `frameSize`); anything posted on that side afterwards is dropped, and once both directions have ended the id is freed on both ends with no `close`, aborting the port's close signal with "the port ended in both directions". A port closed with its `end` still queued sends its `close` alone. An `end` from a peer where it was not agreed, or a `message` or `frame` after a peer's own `end`, closes the port. `duplexOverPort` (and so `connect` / `serve`) ends a stream that finishes normally in both directions this way: each side posts its last chunk, then ends its direction instead of closing, and the port is freed on both ends with no `close` on the wire. An abandoned stream (the caller returns early, a timeout, a teardown, or a last chunk that carries an error) still posts its abort notice and closes, and so does every stream where `end` was not agreed. A peer that ends its direction without finishing it (no last chunk, or one carrying an error) fails the stream, which then posts its notice and closes. A codec spread from a built-in inherits `halfClose`, so its own `read` must accept `end`.

## 0.9.0

### Minor Changes

- 4e88f7b: Pipelined streams on windowed ports. A windowed `open` now lists `caps: ["pipeline"]` and the responder's ack answers with the shared subset (only to an opener that listed some). Once `pipeline` is agreed and the window holds this end's sends, `duplexOverPort` (and so `connect` / `serve`) sends chunks as plain messages bounded by the window instead of one confirmed call per chunk. A peer that pipelines where it was not agreed, past the window plus one chunk, or mixing confirmed and pipelined chunks, fails the stream and closes the port. Every stream chunk is sent as a plain `Uint8Array` that owns its buffer (views, Node `Buffer`s, other typed arrays and `DataView`s are copied, an `ArrayBuffer` is wrapped) and copied again on receipt, so neither end ships or holds a whole buffer per chunk; a chunk that is not bytes ends the stream with the producer's own `TypeError`. Ports without a window, `transferPortMux` ports and peers that answer no capabilities behave as before.

## 0.8.0

### Minor Changes

- eec24c8: `multiplexPort` bounds what it holds of messages reassembled from a peer's frames (`frameSize`):
  
  - **Window:** a partial message counts against its port's window as it arrives. One begun while this side still owed credit must fit what the window left.
  - **Cap:** a message begun with nothing owed may pass the window. What such messages hold past their windows, summed across ports, is at most the new `maxReassembledBytes` option (default `DEFAULT_MAX_REASSEMBLED_BYTES`, 64 MiB; also on `overPipe`). Messages within their windows are not charged, so honest concurrent framing never trips it.
  
  Past either limit, the partial message is dropped, the port closes with a `RangeError`, and the peer gets a `close` with reason `"max-reassembled-bytes"`. A peer that sends frames that never end can no longer make this side hold every byte.
  
  Behaviour change: a framed message more than the receiver's `maxReassembledBytes` past the window used to arrive, and now closes the port. Raise the cap on the receiving side if a peer frames larger messages. A port that closes with messages still queued now sends them whole rather than framed.

### Patch Changes

- cf94377: `serve` forwards `return()` to a handler's output at once, instead of queueing it behind a `next()` the handler has not answered yet, so a handler still working on its first chunk learns its caller left. When a stream is aborted with `maxMessageSize` chunking on, the producer itself is returned — the handler's output on the serving side and the caller's input on the calling side — rather than only the chunker wrapping it, which would queue the `return()` the same way.

## 0.7.0

### Minor Changes

- ec33737: `multiplexPort` / `overPipe` take `keepalive: { intervalMs, misses? }`, off by default. The mux pings the peer every `intervalMs`; the peer answers, and anything it sends counts. After `misses` (default 3) unanswered pings in a row from a peer that has answered before, the mux closes with `webrun-rpc: the peer did not answer …`, catching a realm that died or froze. Ticks while this end's own pipe reports a backlog are not counted. Every current mux answers pings, so one end is enough; an older peer is never closed for it. New `ping` / `pong` envelopes on an id no port takes (`Number.MAX_SAFE_INTEGER`), accepted by `structuredCodec` and `msgpackCodec`.
- 626599d: `multiplexPort` / `overPipe` take `onLeak`, a development aid: a port its consumer dropped without `close()` is reported with its `PortInfo` once the garbage collector reclaims it, and freed on both ends if it has no listener left (one that still listens is still receiving, and is left open). The mux no longer holds a consumer's port object, only its own record, and `openPort`'s `signal` closes its port through that record, so a dropped port can be collected and is still freed when the signal aborts. `Symbol.dispose` also works detached from its port.

## 0.6.0

### Minor Changes

- 30d2cff: `multiplexPort` frees its ports when their transport or their user is done, and a full table says who holds it.
  
  - `signal` option on `multiplexPort` / `overPipe`: aborting it closes the mux with `signal.reason`, so every port's close signal aborts and calls in flight reject instead of hanging.
  - `close(reason?)`: the reason becomes every port's close-signal reason.
  - `openPort(meta, { signal })` closes the port on abort; virtual ports are `Symbol.dispose`-able (`using`).
  - `ports()` lists open ports (`id`, `meta`, `openedAt`, `lastActivity`), and the `maxPorts` `RangeError` names the commonest `meta.kind`s.
- f98d2c4: Fair framing for `multiplexPort` / `overPipe`, off unless `frameSize` (bytes) is set; it needs `window`.
  
  - Every port's messages leave in turn, one per port, whenever the pipe has room, and a message larger than `frameSize` goes as `frame` envelopes the peer reassembles. A small message on one port no longer waits behind a large one on another.
  - `MessageTarget` may implement `whenDrained()` / `bufferedAmount` to say when it is full; framing waits on it between frames.
  - Frames go only on a windowed port whose two ends agreed exact sizes (`exact: true`); older peers get whole messages. Frames anywhere else are dropped.
  - `frameSize` must be a positive integer; anything else is a `RangeError`.
  - With `frameSize`, a port without a window posts at once; a `whenDrained()` that rejects closes the mux with its error; `mux.close()` still posts the close of a port whose close was queued behind its frames.
- 76c3b6d: Per-port flow control for `multiplexPort` / `overPipe`, off unless `window` (bytes) is set.
  
  - Each port has at most `window` bytes delivered to the other side and not yet consumed, in both directions, so a slow consumer holds its own port's budget and no other port's. What exceeds it waits in the port's send queue; `portBufferedAmount(port)` and `whenPortReady(port, below)` let senders wait. `whenPortReady` always resolves on a later task.
  - A message counts as consumed when its listeners return, or their promises settle. Credit goes back in batched `credit` envelopes.
  - Safe against older peers: neither end holds back until the other has shown it reads credit — the responder's zero-byte `credit` ack proves it to the opener, and the opener's answer to that ack proves it to the responder. A peer that never answers credit keeps running without flow control.
  - `PortCodec` may implement `encode(envelope)` / `decode(data)` so the window counts exact wire bytes; `msgpackCodec` does, and accepts the `credit` envelope.
  - `mux.ports()` reports a windowed port's `window` (once in force), `queued`, `outstanding` and `unconsumed` bytes.

## 0.5.1

### Patch Changes

- b224431: Ready for `await using` where the runtime has `Symbol.asyncDispose`: `connect`'s calls and `duplexOverPort`'s caller streams dispose as `return()` (the stream ends at once, even with a `next()` pending), and an `HttpLink` disposes as `close()`. Native async generators get this from `AsyncIteratorPrototype` in runtimes that implement it; these hand-written iterators carry it themselves. Installed at run time only, and kept off the declared types, which would otherwise require the `esnext.disposable` lib.
- a7d06aa: Module-level constants (text encoders, the close-signal table) are annotated pure, so bundlers drop them with the code that uses them.
- 839e6f7: A caller that gives up on a stream (`return()` or `throw()` on `connect`'s call, or on `duplexOverPort`'s) while it waits for the peer's next chunk ends the stream at once: the stream is aborted, the peer is told, and the port is closed; a `next()` that was pending resolves done. Before, an async generator queued the `return()` behind the pending `next()`, so a stream to a peer that never answered — an aborted request to a hung handler — kept its port for good.
- Updated dependencies [a7d06aa]
  - @statewalker/webrun-streams@0.2.3

## 0.5.0

### Minor Changes

- ba6ae47: Closing a link fails the calls in flight on it. A virtual port of `multiplexPort` now has a close signal (`getPortCloseSignal`), aborted when the port is closed locally, by the peer, or by `PortMux.close()`; `callPort` already honoured it, and both halves of a `duplexOverPort` stream now abort on it. Before, `close()` on a `connect` link left a call waiting for the peer's next chunk pending forever. The error is `MUX_CLOSED_MESSAGE` ("webrun-rpc: the multiplexer was closed"), newly exported.

## 0.4.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.4.0

### Minor Changes

- fbaee6a: `connect`/`serve` take a port FACTORY, not a port.

  They used to take one `MessageTarget` plus `side` and build an id table inside
  themselves, which forced a single multiplexing strategy on every transport.
  That is correct where the transport gives you exactly one channel — a
  `MessagePort`, a WebSocket — and wrong everywhere else. A libp2p connection
  multiplexes already, so running the id table inside it stacked two
  multiplexers with no way to tell which one stalled; a transferable boundary
  moves real ports and needs no table at all.

  ```ts
  // before
  await serve({ port: channel.port2, side: "responder" }, handler);

  // after
  await serve(
    {
      mux: overPipe(channel.port2, {
        codec: structuredCodec,
        side: "responder",
      }),
    },
    handler
  );
  ```

  `PortMux` was already the seam for this — `openPort()` outbound, `onPort`
  inbound, `maxMessageSize` reported — so the change is mostly deletion:
  `connect`/`serve` now ask a factory for one port per call and run
  `duplexOverPort` on it. Three options leave the API with the table they
  described:

  - **`side`** is `multiplexPort`'s id parity and moves to `overPipe`. A caller
    over a self-multiplexing transport has no ids and no parity, and the old
    signature made them pass one anyway.
  - **`maxPorts`** bounds an id table that may not exist; it moves to `overPipe`.
  - **`maxMessageSize`** stops being a parameter and becomes something the mux
    **reports**. A libp2p stream has no message ceiling and splits nothing; a
    LiveKit data channel has one. Neither is the consumer's to know.

  `timeout` stays on `connect`/`serve`, because it is about the stream rather
  than the transport.

  **Why a factory and not a `PortMux` you hand over already built.** Every mux
  decides accept-or-reject _synchronously_, inside the `open` envelope, and tells
  the peer on the spot — `multiplexPort` posts `{type:"close", reason:"rejected"}`
  before returning. There is no "decide later", and layer 1 refuses to queue what
  it cannot deliver. A mux handed over already built therefore has a window
  between its construction and its handler being attached, and a port arriving in
  that window is rejected outright: measured, zero messages delivered, with the
  peer told `rejected` for a call whose only fault was being early. A factory
  closes the window by construction — the mux cannot exist before the thing that
  answers it. Both halves are measured in `port-factory-no-race.test.ts`.

  `connect` passes no handler, which is how a caller declines inbound ports; the
  factory receives `undefined`. Whichever of the two called it owns the mux and
  closes it.

  Two factories ship: `overPipe(pipe, { codec, side?, maxPorts?, maxMessageSize? })`
  for one pipe of bytes, and `overPorts(factory)` as a pass-through so an adapter
  can supply its own `PortMux` without this package learning what that transport
  is.

  Validated against libp2p outside this repository before the change was made:
  the same consumer runs over a `MessagePort` with an id table and over a libp2p
  connection without one, and on libp2p each call is exactly one stream.

## 0.3.0

### Minor Changes

- 0e435d6: `connect` / `serve` are now the port stack, not `emulateMux`.

  They used to wrap the port as a `ByteChannel` and run `emulateMux` inside it: a
  byte pipe with stream ids framed into it, and a credit window measured in bytes.
  They now open one virtual port per call with `multiplexPort` and run that call
  with `duplexOverPort` — which is the composition `duplexOverPort`'s own
  changeset described, finally used by the adapter rather than only by a
  parallel conformance run.

  **Why bother, when the old one worked.** Because "worked" meant "bounded by
  `maxStreamBuffer`". `emulateMux` grants a sender credit and buffers whatever
  arrives until the consumer pulls it, so a fast producer over a stalled consumer
  runs ahead until it has filled 8 MiB — the default — and the only lever is to
  choose a smaller number. The stream tier withholds a chunk's confirmation until
  the consumer has pulled past the value, so a producer is at most one chunk ahead
  and there is no number to choose. The difference is measured, not asserted:
  `connect-serve-backpressure.test.ts` runs a 5000-chunk producer into a handler
  that reads exactly one chunk and then stops reading. Against `emulateMux` the
  producer reached **5000 of 5000**. Against this implementation it reaches
  **1**, and the remaining 4999 still arrive intact once the consumer resumes.
  That test fails on an unbounded implementation, which is the only kind of
  backpressure test worth having — the conformance suite's L6 passes on both,
  because completion and integrity are exactly what a transport that swallows the
  whole body into a queue delivers beautifully.

  **`PortParams.mux` changes shape.** It was `EmulateMuxOptions`; it is now
  `PortMuxParams` — `maxPorts`, `maxMessageSize`, `timeout`. This is a breaking
  change to that field and it is deliberate that the old names are gone rather
  than accepted and ignored: `mtu` has a genuine successor in `maxMessageSize`,
  but `maxStreamBuffer` has none, and a caller who sets a buffer ceiling to cap
  memory deserves a compile error rather than a silent no-op. `port` and `side`
  are unchanged, `side` still defaults asymmetrically, and everything the
  `Connect` / `Serve` seam promises — `{ call, close }`, an idempotent teardown,
  `.return()` unwinding the producer, a throw surfacing at the consumer — is
  unchanged.

  Two behaviours are better than before, both consequences of the stack rather
  than of new code here:

  - `serve`'s teardown now abandons the streams still running _before_ it drops
    the transport, so the peer's callers reject with "the peer abandoned the
    stream" instead of parking forever on a port that has silently gone inert.
    Layer 1's close is not observable to layer 2; the notice has to be posted
    deliberately, and it is.
  - A call's port is opened on the consumer's first pull, not when `call` is
    invoked. Building a stream and dropping it without iterating now costs the
    peer nothing; before it burned a stream id and left the responder holding a
    handler for a call that never arrived.

  The conformance run over `connect` / `serve` is unchanged in its assertions. Its
  pair factory now translates `PairTuning.mtu` into `maxMessageSize` and drops
  `maxStreamBuffer`, which keeps L6 running its 256 KiB body as 64 frames instead
  of one — more coverage than the hand-wired pair gets, and still not a proof of
  flow control, which is why the backpressure test exists separately.

  `byteChannelFromMessagePort` is untouched and still exported. It is now the only
  thing in the package that touches `ByteChannel`, and it still goes away with
  `emulateMux` in Plan C.

## 0.2.0

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

- 3c0f98a: Adds the stream tier and a second port multiplexer.

  `duplexOverPort(port, options)` runs one `Duplex` over one port, and
  `serveDuplexOverPort(port, handler, options)` is its serving half. Each
  direction is one `callPort` per chunk on its own channel; the reply is the
  confirmation and it is withheld until the consumer has pulled past the value,
  so a producer can never run more than one chunk ahead. Memory is bounded by
  construction rather than by a configured ceiling: at most one chunk per open
  port. A peer that sends a second unconfirmed chunk has its call refused and
  that port closed, leaving every other port untouched.

  The stream carries the timeout, and it defaults to **none**. `callPort` gains
  `NO_TIMEOUT` for the same reason: a per-chunk deadline fails a slow consumer,
  which is a bug, not a policy. The regression test is a consumer 1200 ms per
  chunk completing a transfer.

  `transferPortMux(target, options)` is a second `PortMux` whose ports are real
  transferred `MessagePort`s — one `MessageChannel` per `openPort`, one end
  handed to the peer. It needs structured clone with transferables, so it works
  in browsers, workers and iframes and not over byte transports; the caller picks
  it explicitly. Unlike an emulated port, a transferred one can cross a boundary
  and be used by code that never saw the parent port.

  Nothing is removed. `emulateMux`, `connect`/`serve` and the existing
  conformance run are unchanged, and the new stack is proven by a **second**
  conformance run over the same unmodified L0–L6 suite.

  **If you set `maxMessageSize`, leave a margin.** It bounds the **payload**, not
  the frame: `duplexOverPort` chunks to it and the envelope framing is added on
  top afterwards — measured at 123-128 bytes over `@statewalker/webrun-msgpack`'s
  `msgpackCodec`, and not constant, since the call id's length varies per chunk.
  Set it to a transport's exact ceiling and a full-size chunk overruns it, which
  on LiveKit means the body arrives as zero bytes with no error on either side.
  Use `transportLimit - 256`.

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

- 4f958b9: A port multiplexer, in the package that now defines its central type.

  `multiplexPort` turns one `MessageTarget` into many virtual ones, with explicit
  `open`/`close` lifecycle and an accept callback. Virtual ports are themselves
  `MessageTarget`s, so the multiplexer composes and a real `MessagePort` is
  substitutable for a virtual one.

  Layer 1 has no flow control by design — no backpressure, acknowledgements,
  credit or buffering ceiling — and a message for a port with no consumer is
  dropped rather than queued, so an unaccepted port cannot accumulate memory.

  `structuredCodec` ships here too; a byte codec belongs with
  `@statewalker/webrun-msgpack`. `@statewalker/webrun-streams`, which the
  multiplexer's virtual ports build on, keeps its zero runtime dependencies —
  `webrun-rpc` is the only package that depends on it.

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

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

> Released as `@statewalker/webrun-streams-port` up to and including 0.1.1. The package was renamed
> in anticipation of the transport-agnostic RPC tier becoming its sole purpose; the transport role
> (`connect`, `serve`, `byteChannelFromMessagePort`) is still present and is removed in a later
> plan. Entries below that point describe the package under the old name.

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
