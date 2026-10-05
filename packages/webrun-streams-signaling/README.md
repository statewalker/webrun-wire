# @statewalker/webrun-streams-signaling

## What it is

Connection-setup helpers for peer-to-peer links. Each one runs a handshake and hands back an
established `@statewalker/webrun-streams` `ByteChannel` (`send` / `recv` / `closed` / `close`).
`PeerManager` runs WebRTC offer/answer/ICE over a signaling transport you supply; `QrSignaling`
pairs two devices without a server by exchanging compact QR strings; `RoomManager` joins a
LiveKit-style room and opens a channel per participant. What runs on the channel afterwards —
typically `webrun-streams`' `emulateMux` — is up to you.

## Why it exists

Every peer-to-peer transport needs the same preliminary step: find the peer, exchange session
descriptions and ICE candidates, and wait for a data channel to open. That step is separate from
moving bytes. This package does only that step and stops at a `ByteChannel`, so any byte protocol
can run on the result. It contains no signaling server (STUN/TURN/rendezvous); these are clients.
Vendor code stays out of the import graph: native WebRTC is reached through an injectable factory
and LiveKit through a structural `RoomLike` interface and a `roomFactory`, so the package can be
tested with in-memory mocks and `livekit-client` is only needed if you use `RoomManager`.

## How to use

```sh
pnpm add @statewalker/webrun-streams-signaling
# only for RoomManager:
pnpm add livekit-client
```

`livekit-client` (`^2.18.3`) is an optional peer dependency; the package never imports it, you
pass `() => new Room()`. One entry point, `.`, ESM only. It targets browsers: it uses
`RTCPeerConnection` (unless you inject `rtc`), `crypto.getRandomValues`, `btoa` / `atob`. In Node,
pass an `rtc` factory from a WebRTC implementation.

### Exports

| Export | Purpose |
| --- | --- |
| `new PeerManager(signaling, options?)` | WebRTC connections keyed by peer id over a `SignalingTransport`. `connect(peerId): Promise<ByteChannel>`, `onConnection((peerId, ch) => void): () => void`, `close()`. |
| `PeerManagerOptions` | Same as `WebRtcConnectionOptions`. |
| `new QrSignaling(options?)` | Serverless pairing. `offer(): Promise<{ qr, accept(answerQr): Promise<ByteChannel> }>`, `answer(offerQr): Promise<{ qr, channel }>`, `getSessionId()`. |
| `QrSignalingOptions` | `{ sessionId?: string; connection?: WebRtcConnectionOptions }`. |
| `new RoomManager(options: RoomManagerOptions)` | Room membership. `join(room)`, `participants(): AsyncIterable<string>`, `channelTo(peerId): Promise<ByteChannel>`, `leave()`. |
| `new PeerConnection(role, options?)` | One WebRTC connection's lifecycle, which `PeerManager` and `QrSignaling` build on. `connect()`, `handleSignal(msg)`, `open(): Promise<ByteChannel>`, `waitForIceGathering()`, `getLocalDescription()`, `getCollectedCandidates()`, `getState()`, `getRole()`, `getDataChannel()`, `on` / `off`, `close()`. |
| `byteChannelFromDataChannel(dc)` | Wrap an `RTCDataChannel` as a `ByteChannel`. |
| `byteChannelFromRoom(room, peerId)` | A `ByteChannel` to one participant of a `RoomLike`. |
| `generateSessionId()`, `createCompressedSignal(...)`, `parseCompressedSignal(signal)`, `encodeSignal(signal)`, `decodeSignal(text)` | The pure QR payload functions. |

Types and constants: `SignalingTransport` (`localId`, `send(to, msg)`,
`onMessage(handler): () => void`), `SignalingMessage` (`offer` / `answer` / `candidate` /
`ready`), `SessionDescription`, `IceCandidate`, `PeerRole`, `ConnectionState`,
`PeerConnectionEvents` (`stateChange`, `signal`, `open`, `close`, `error`),
`WebRtcConnectionOptions`, `RtcPeerConnectionFactory`, `DEFAULT_ICE_SERVERS` (two Google STUN
servers), `CompressedSignal`, `RoomLike`, `RoomParticipantLike`, `RoomLocalParticipantLike`,
`RoomManagerOptions` (`url`, `getToken(room)`, `roomFactory`), `ROOM_EVENT` (the three LiveKit
event names used), `ParticipantInfo` (exported, not used by any API here).

`WebRtcConnectionOptions`:

| option | default | meaning |
| --- | --- | --- |
| `iceServers` | `DEFAULT_ICE_SERVERS` | ICE servers. |
| `connectionTimeout` | 30000 ms | How long `open()` waits for the data channel. |
| `iceGatheringTimeout` | 5000 ms | How long `QrSignaling` waits for ICE gathering before using what it has. |
| `channelLabel` | `"webrun-data"` | Data channel label. |
| `ordered` | `true` | Ordered delivery. |
| `maxRetransmits` | unset | Retransmit limit for unreliable mode. |
| `rtc` | `new RTCPeerConnection(config)` | Factory for the peer connection. |

## Examples

### `PeerManager`: dial a peer over your signaling channel, then multiplex

The `SignalingTransport` below is an in-memory bus, so both peers run in one page; in an
application it wraps your WebSocket or other rendezvous channel.

```ts
import { emulateMux } from "@statewalker/webrun-streams";
import {
  PeerManager,
  type SignalingMessage,
  type SignalingTransport,
} from "@statewalker/webrun-streams-signaling";

function signalingBus() {
  const handlers = new Map<string, (from: string, msg: SignalingMessage) => void>();
  return (localId: string): SignalingTransport => ({
    localId,
    send: (to, msg) => queueMicrotask(() => handlers.get(to)?.(localId, msg)),
    onMessage(handler) {
      handlers.set(localId, handler);
      return () => handlers.delete(localId);
    },
  });
}

const bus = signalingBus();
const a = new PeerManager(bus("A"));
const b = new PeerManager(bus("B"));

b.onConnection((peerId, channel) => {
  const mux = emulateMux(channel, { side: "responder" });
  mux.serve(async function* echo(input) {
    for await (const chunk of input) yield chunk;
  });
});

const channel = await a.connect("B");
const mux = emulateMux(channel, { side: "initiator" });
for await (const chunk of mux.call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

a.close();
b.close();
```

### `QrSignaling`: pair two devices without a server

```ts
import { QrSignaling } from "@statewalker/webrun-streams-signaling";

// Device A
const deviceA = new QrSignaling();
const { qr: offerQr, accept } = await deviceA.offer(); // show offerQr as a QR code

// Device B, after scanning offerQr
const deviceB = new QrSignaling();
const { qr: answerQr, channel: channelB } = await deviceB.answer(offerQr); // show answerQr

// Device A, after scanning answerQr
const channelA = await accept(answerQr);
```

**This flow does not currently complete against a real WebRTC stack**; see
[What `answer()` waits for](#what-answer-waits-for).

### `RoomManager`: one channel per participant

```ts
import { Room } from "livekit-client";
import { RoomManager } from "@statewalker/webrun-streams-signaling";

const rooms = new RoomManager({
  url: "wss://livekit.example.com",
  getToken: (room) => fetch(`/token?room=${room}`).then((r) => r.text()),
  roomFactory: () => new Room(),
});

await rooms.join("room1");
for await (const peerId of rooms.participants()) {
  const channel = await rooms.channelTo(peerId);
  channel.send(new Uint8Array([5, 5]));
}
// participants() does not end until leave() is called
```

## Internals

```
  SignalingTransport / QR strings / LiveKit room      (you provide)
                │  offer, answer, ICE candidates
                ▼
  PeerConnection ── RTCPeerConnection (or your `rtc` factory)
                │  data channel opens
                ▼
  ByteChannel  ── send / recv / closed / close
                │
                ▼
  emulateMux or any byte protocol                      (you run)
```

### How `PeerManager` routes signals

Each peer id maps to one `PeerConnection`. `connect(peerId)` creates an initiator, creates the
data channel and offer, and resolves when the channel opens. An inbound `offer` from an unknown
peer creates a responder; `onConnection` handlers are called when its channel opens. Answers and
candidates from unknown peers are ignored. Candidates that arrive before the remote description
is set are queued and applied after it. When ICE gathering completes, a `{ type: "ready" }`
signal is sent; receivers ignore it. A connection is forgotten when its data channel closes.

### What `answer()` waits for

`QrSignaling` sends everything in one payload: it waits for ICE gathering (up to
`iceGatheringTimeout`), then packs the SDP and all gathered candidates. `offer()` returns the
offer QR and an `accept` that applies the answer. `answer()`, however, awaits the responder's data
channel before it returns the answer QR. With a real WebRTC stack that channel opens only after
the initiator has applied the answer, which needs the answer QR. So `answer()` rejects with
`Connection timeout after <connectionTimeout>ms` instead of returning, and the flow in the example
above does not complete. The test suite uses a mock `RTCPeerConnection` that opens the channel as
soon as both descriptions are set on one side, so it does not exercise this ordering.

`offer()` starts waiting for its channel immediately. If `accept` is never called, that wait
rejects after `connectionTimeout` with nothing attached to it: an unhandled rejection, which
terminates a Node process.

### How QR payloads stay small

`createCompressedSignal` keeps only the SDP lines needed to connect (`v=`, `o=`, `s=`, `t=`,
`m=`, `c=`, `a=group:`, `a=ice-ufrag:`, `a=ice-pwd:`, `a=fingerprint:`, `a=setup:`, `a=mid:`,
`a=sctp-port:`, `a=max-message-size:`) and packs each candidate into a `|`-separated string
(unparseable candidates are kept raw, prefixed `R:`). `encodeSignal` is URL-safe base64 of the
JSON, without padding. `parseCompressedSignal` throws `Unsupported protocol version: <v>` for any
version other than 1, and a malformed packed candidate throws
`Invalid compressed candidate: <text>`.

### How the channels behave

- Both channels buffer inbound bytes from the moment they are created, so data that arrives
  before your `for await` starts is not lost.
- `byteChannelFromDataChannel` sets `binaryType = "arraybuffer"` and copies every inbound payload.
  A non-byte message (a string) throws `TypeError: byte channel received a non-byte payload`
  inside the channel's `message` listener. `closed` resolves on the data channel's `close` event
  or on `close()`. A `send` on a closed channel is swallowed.
- `byteChannelFromRoom` publishes with `reliable: true` to `destinationIdentities: [peerId]` and
  accepts `dataReceived` events from that participant (or with no participant). Its `closed`
  resolves only when you call `close()`; it does not watch for the participant leaving or the
  room disconnecting.

### What `RoomManager` tracks

`participants()` yields the identities already in the room when `join` returns, then each one
that joins, and ends at `leave()`. Departures are not reported. Only the most recently created
`participants()` iterator receives new joiners. `channelTo()` before `join()` throws
`channelTo() before join()`.

### Failure modes

- `PeerConnection.open()` rejects with `Connection timeout after <n>ms`, with the data channel's
  error, or with `Connection failed` when the connection state becomes `failed`.
- `connect()` on a responder throws `connect() should only be called by initiator`; an offer to an
  initiator throws `Received offer but not in responder role`; an answer to a responder throws
  `Received answer but not in initiator role`.
- On the `PeerManager` responder side, a connection that never opens is never reported to
  `onConnection`; its `open()` rejection has no handler attached and surfaces as an unhandled
  rejection.

### Dependencies

Zero runtime imports: the bundle imports nothing. `@statewalker/webrun-streams` is a dependency
for the `ByteChannel` type only. `livekit-client` is an optional peer, used only through the
`RoomLike` shape you inject. A neutrality test (`tests/neutrality.test.ts`) keeps the source from
importing anything else.

## License

MIT
