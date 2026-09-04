# @statewalker/webrun-streams-signaling

Generic P2P signaling / connection-setup helpers — `PeerManager`, `QrSignaling`, `RoomManager` — that each yield a webrun-streams `ByteChannel`.

## Overview

Signaling here is **transport-setup only**: it runs the handshake (WebRTC offer/answer/ICE, or LiveKit room membership) that *establishes* a peer connection, then hands back an established `ByteChannel`. The byte transport and multiplexing on top of that channel is `@statewalker/webrun-streams`. These helpers were relocated out of the retired `@statewalker/vcs-port-*` packages and neutralised — nothing here is Git/VCS-specific — so a generic P2P concern lives in the webrun ecosystem. Vendor libraries (`livekit-client`) are optional peer-deps injected via a factory; native WebRTC is likewise injectable, so tests need no vendor install.

**Out of scope:** the byte transport / multiplexing (`@statewalker/webrun-streams`), and the signaling *server* (STUN/TURN/rendezvous) — a deployment concern; these are clients.

## Installation

```bash
pnpm add @statewalker/webrun-streams-signaling
```

## Quick Start

`PeerManager` dials a peer over a `SignalingTransport` (your websocket / rendezvous side-channel) and resolves with a `ByteChannel`:

```typescript
import { PeerManager } from "@statewalker/webrun-streams-signaling";

// `signaling` is your SignalingTransport (localId + send + onMessage).
// In production `PeerConnection` defaults to `new RTCPeerConnection(config)`;
// pass `{ rtc }` only to inject a factory (tests, or a non-browser stack).
const a = new PeerManager(signalingA);
const b = new PeerManager(signalingB);

b.onConnection((peerId, ch) => {
  ch.send(new Uint8Array([1, 2, 3]));
});

const ch = await a.connect("B"); // Promise<ByteChannel>
ch.send(new Uint8Array([9, 8]));
```

`QrSignaling` pairs two devices serverless, exchanging compact QR strings:

```typescript
import { QrSignaling } from "@statewalker/webrun-streams-signaling";

const deviceA = new QrSignaling();
const deviceB = new QrSignaling();

const { qr: offerQr, accept } = await deviceA.offer();   // display offerQr
const { qr: answerQr, channel: chB } = await deviceB.answer(offerQr); // scan + reply
const chA = await accept(answerQr);                      // both sides now have a ByteChannel
```

`RoomManager` joins a LiveKit-style room and opens a `ByteChannel` per participant:

```typescript
import { RoomManager } from "@statewalker/webrun-streams-signaling";
import { Room } from "livekit-client";

const room = new RoomManager({
  url: "wss://my-livekit-host",
  getToken: (name) => fetchToken(name),
  roomFactory: () => new Room(),
});

await room.join("room1");
for await (const peerId of room.participants()) {
  const ch = await room.channelTo(peerId);
  ch.send(new Uint8Array([5, 5]));
}
await room.leave();
```

## API

### Managers

- **`class PeerManager`** — `new PeerManager(signaling: SignalingTransport, options?: PeerManagerOptions)`. WebRTC peer discovery + connection over a signaling transport.
  - `connect(peerId: string): Promise<ByteChannel>` — dial a peer; resolves with the established channel.
  - `onConnection(handler: (peerId: string, ch: ByteChannel) => void): () => void` — accept inbound dials; returns an unsubscribe fn.
  - `close(): void` — tear down all connections and stop listening.
- **`class QrSignaling`** — `new QrSignaling(options?: QrSignalingOptions)`. Serverless offer/answer exchange via QR strings.
  - `offer(): Promise<{ qr: string; accept(answerQr: string): Promise<ByteChannel> }>` — create an offer QR; `accept` finishes the handshake.
  - `answer(offerQr: string): Promise<{ qr: string; channel: ByteChannel }>` — consume an offer QR, produce an answer QR + the channel.
  - `getSessionId(): string`.
- **`class RoomManager`** — `new RoomManager(options: RoomManagerOptions)`. LiveKit room membership + per-participant channels.
  - `join(room: string): Promise<void>`, `participants(): AsyncIterable<string>`, `channelTo(peerId: string): Promise<ByteChannel>`, `leave(): Promise<void>`.

### ByteChannel adapters

- **`byteChannelFromDataChannel(channel: RTCDataChannel): ByteChannel`** — wrap an established `RTCDataChannel`.
- **`byteChannelFromRoom(room: RoomLike, peerId: string): ByteChannel`** — per-participant channel over a LiveKit-style `Room`.

### Low-level

- **`class PeerConnection`** — single WebRTC connection lifecycle (offer/answer/ICE) that `PeerManager` and `QrSignaling` build on.

### QR pure functions

- **`generateSessionId(): string`** — short random session id.
- **`createCompressedSignal(sessionId, role, description, candidates): CompressedSignal`** — build a compact QR payload from SDP + ICE.
- **`parseCompressedSignal(signal): { sessionId, role, description, candidates }`** — reverse of the above.
- **`encodeSignal(signal): string`** / **`decodeSignal(encoded): CompressedSignal`** — URL-safe base64 (de)serialisation for QR strings.

### Types and constants

All re-exported from `./types` at the package root.

| Export | Kind | Purpose |
| --- | --- | --- |
| `SignalingTransport` | interface | The pluggable channel offers/answers travel over. |
| `SignalingMessage` | union | Offer / answer / ICE-candidate envelopes. |
| `SessionDescription` / `IceCandidate` | interface | Structural views of the WebRTC handshake payloads (no DOM types required). |
| `PeerRole` | `"initiator" \| "responder"` | Which side of the handshake this peer plays. |
| `ConnectionState` | union | Lifecycle state reported by `PeerConnection`. |
| `PeerConnectionEvents` | interface | The event callbacks `PeerConnection` accepts. |
| `WebRtcConnectionOptions` | interface | ICE configuration and the injected `rtc` factory. |
| `RtcPeerConnectionFactory` | type | `(config: RTCConfiguration) => RTCPeerConnection` — the injection seam that keeps native WebRTC out of the import graph. |
| `DEFAULT_ICE_SERVERS` | const | STUN servers used when none are supplied. |
| `CompressedSignal` | interface | The compact offer/answer shape behind the QR helpers. |
| `RoomLike` / `RoomParticipantLike` / `RoomLocalParticipantLike` | interface | Structural view of a LiveKit room, so `livekit-client` stays an optional peer dependency. |
| `RoomManagerOptions` | interface | Includes `roomFactory`, the injection point for the real `Room`. |
| `ParticipantInfo` | interface | Identity + metadata for a room participant. |
| `ROOM_EVENT` | const | Room event-name constants used by `RoomManager`. |

## Notes

- Each helper yields a webrun-streams **`ByteChannel`** (`send` / `recv` / `closed` / `close`), not a `MessagePort` — the byte transport and `emulateMux` run on top via `@statewalker/webrun-streams`.
- **Vendor coupling stays behind optional peer-deps.** `livekit-client` is injected via `RoomManagerOptions.roomFactory` (the module keeps only a structural `RoomLike` view), and native WebRTC is injected via the optional `rtc` factory (defaulting to `new RTCPeerConnection`). So the tests use in-memory mocks and require no vendor install.
- **`peerjs` is not a dependency.** These helpers use native WebRTC; the peerjs byte transport lives in `@statewalker/webrun-streams-peerjs`.
- Built red/green TDD.

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | `ByteChannel`, and `emulateMux` for the transport built on top. |
| `livekit-client` | **peer, optional** (`^2.18.3`) | Only for `RoomManager`. Injected via `RoomManagerOptions.roomFactory`; the module itself keeps a structural `RoomLike` view, so the dependency is avoidable. |

Native WebRTC is likewise injected (the optional `rtc` factory, defaulting to
`new RTCPeerConnection`), which is why the test suite needs no vendor install.
`peerjs` is deliberately **not** a dependency — that transport lives in
[`@statewalker/webrun-streams-peerjs`](../webrun-streams-peerjs).

ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
