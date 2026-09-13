---
"@statewalker/webrun-rpc": minor
---

`connect` / `serve` are now the port stack, not `emulateMux`.

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

- `serve`'s teardown now abandons the streams still running *before* it drops
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
