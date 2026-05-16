# 2. Standard `MessagePort` is the canonical port seam

Date: 2026-05-14

## Status

Superseded by [ADR-0004 — Duplex is the canonical adapter seam](./0004-duplex-as-seam.md) (2026-05-16).

The decision below remains operationally valid for the legacy `webrun-port-*` family until those packages are deleted in a follow-up change. New adapters target the `Duplex` seam.

## Context

The `webrun-wire` stack moves bytes between peers through several layers: a transport-specific adapter (WebSocket, WebRTC, libp2p, LiveKit, PeerJS, …), a port-shaped object exposed by that adapter, `webrun-ports` framing primitives (`callPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`) operating on that port, and HTTP / RPC / Git layers above.

Before the `webrun-port-adapters` change, the codebase contained three competing types for "a thing you `postMessage` bytes through":

- Native WHATWG `MessagePort` — what every `port-*` adapter actually returns and what `webrun-ports` operates on.
- `MessageTarget` in `webrun-http-browser/src/core/message-target.ts` — a structural subtype with `addEventListener('message')` / `postMessage` / optional `start` and `close`. Introduced because the page⇄ServiceWorker handshake passes through `ServiceWorkerContainer`, which is not a `MessagePort`. After the handshake, a real `MessagePort` is transferred and used for per-request HTTP.
- `WebSocketLike` in `webrun-ports-ws/src/websocket-like.ts` — a *source* type the adapter consumes to produce a real `MessagePort`.

It is tempting to define a fourth type — `MessagePortLike` — as the canonical "port" shape in the stack. The argument: native `MessagePort` is wider than what a bridged transport can deliver (`postMessage(any, [transferable])` allows objects and ownership transfer that WebRTC / libp2p / WebSocket / LiveKit cannot carry), so a narrower type would catch misuse at compile time.

## Decision

We use the standard WHATWG `MessagePort` interface as the canonical port type at every API boundary in `webrun-port-core`, `webrun-port-conformance`, every `webrun-port-X` adapter, and every consumer in the `webrun-wire` stack. No custom `MessagePortLike` interface is introduced.

## Rationale

- **The standard type is already the de-facto canonical type.** All existing `port-*` prototypes return native `MessagePort`. `webrun-ports` operates on native `MessagePort`. The wider stack already speaks it.
- **The standard type is universally known.** Every web developer knows `MessagePort`. Every browser ships it. Node has `MessagePort` in `worker_threads`. TypeScript ships its lib types out of the box.
- **The outliers do not actually need a new type.** `MessageTarget` exists for the SW-registration *handshake*, not for byte transport — it is renamed to `SwHandshakeTarget` in its own follow-up and removed from any general "port" context. `WebSocketLike` is a source type, not a port type.
- **The contract gap is a documentation problem, not a type-system problem.** The interface document and the conformance suite together name the byte-only / no-transferables / ordered-reliable constraints and enforce them at runtime against every adapter. Compile-time enforcement would catch misuse one layer earlier at the cost of a custom type every consumer must learn.
- **Compile-time enforcement of "byte-only" is brittle.** A narrower `postMessage(data: Uint8Array): void` signature would reject legitimate callers that post the `callBidi` envelope object (a JSON-shaped structured value, not a `Uint8Array`). The adapter must support both shapes. The narrower type cannot be made narrow enough to actually catch bridge violations without breaking real usage.

## Consequences

- Every adapter and every framework function in `webrun-wire` typed against native `MessagePort`.
- `webrun-port-core`'s README documents the byte-only / no-transferables / ordered-reliable contract as the operational constraints that bridges deliver. Consumers reading the docs know what they get.
- The `webrun-port-conformance` suite enforces the contract at runtime against every adapter in the family. Adding a new adapter means passing `describePortAdapter` — no new type plumbing needed.
- If a future use case genuinely requires compile-time enforcement (e.g., a `BytePortHandle` type for byte-only consumers), it can be added as a structural subset of `MessagePort` without breaking the canonical seam established here.

## Alternatives considered

1. **Define `MessagePortLike` as a narrower structural type.** Rejected: cost (custom type every consumer learns) outweighs benefit (compile-time enforcement that cannot in practice be made narrow enough without breaking real usage), and the standard type is already the de-facto canonical type.
2. **Use the existing `MessageTarget` as the canonical type.** Rejected: `MessageTarget` was introduced for a SW-handshake purpose, not as a port type. Promoting it to "the port type" conflates two distinct concerns and would not address the `transferable` gap either.
