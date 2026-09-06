---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-streams-conformance": minor
"@statewalker/webrun-streams-ws": minor
"@statewalker/webrun-streams-peerjs": minor
"@statewalker/webrun-streams-livekit": minor
"@statewalker/webrun-http-browser": minor
---

Replace stop-and-wait flow control with credit-based flow control in `emulateMux`.

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
