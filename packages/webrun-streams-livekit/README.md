# @statewalker/webrun-streams-livekit

LiveKit-backed `Connect` / `Serve` adapter in the `webrun-streams-*` family.

## What this is

A binding between a connected LiveKit [`Room`](https://docs.livekit.io/client-sdk-js/classes/Room.html)
and the [`webrun-streams`](../webrun-streams) `Duplex` seam. A room plus a
remote participant identity becomes one `ByteChannel`; `emulateMux` layers many
concurrent logical calls on top.

Your handler is an ordinary `Duplex` —
`(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>` — the same
function you would run over a WebSocket or WebRTC.

## Why it exists

Peer-to-peer links are excellent until they aren't: symmetric NATs, corporate
firewalls, mobile networks and multi-party sessions all argue for a managed
SFU. LiveKit provides one, with authentication, room membership and presence
already solved.

What LiveKit's data channel does *not* provide is request semantics. This
adapter adds them, so an application written against the `Duplex` seam can move
from a direct WebRTC link to a LiveKit room by changing one import — the
handlers, the HTTP layer above them, and the tests all stay put.

Publishes are forced to LiveKit's **`RELIABLE`** mode (ordered, retransmitted),
because the framing above assumes byte-stream ordering.

## Install

```sh
npm install @statewalker/webrun-streams-livekit livekit-client
```

`livekit-client` is a **peer dependency** (`^2.18.3`) — you own the `Room`, its
token, and its lifecycle.

## Getting started

Both sides take the same parameters: a connected `Room` and the identity of the
participant at the other end.

Responder:

```ts
import { Room } from "livekit-client";
import { serve } from "@statewalker/webrun-streams-livekit";

const room = new Room();
await room.connect(url, token); // identity: "agent-7"

const stop = await serve({ room, peerIdentity: "client-3" }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});
```

Caller:

```ts
import { connect } from "@statewalker/webrun-streams-livekit";

const { call, close } = await connect({ room, peerIdentity: "agent-7" });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
```

### Carrying HTTP over it

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/events"));
```

[`apps/livekit-demo`](../../apps/livekit-demo) runs this end to end — a dev
LiveKit server, a token service, and two browser pages exchanging HTTP and SSE
through a room.

## API

### `connect(params): Promise<{ call, close }>`

Type: `Connect<LiveKitParams>`. Each `call(input)` opens a new logical stream
addressed to `peerIdentity`; `close()` tears them down. It does not disconnect
the `Room`, which you own.

### `serve(params, handler): Promise<() => Promise<void>>`

Type: `Serve<LiveKitParams>`. Runs `handler` for inbound streams from
`peerIdentity`. Returns an idempotent teardown.

### `LiveKitParams`

| Field | Type | Meaning |
| --- | --- | --- |
| `room` | `Room` | An already-connected LiveKit room. |
| `peerIdentity` | `string` | Identity of the remote participant this side talks to. |

### `byteChannelFromLiveKit(room, peerIdentity): ByteChannel`

Wraps a room + peer identity as a `ByteChannel` (`send` / `recv` / `closed` /
`close`) for driving `emulateMux` yourself.

## Conformance

Conformance is **browser-gated** — it needs a real LiveKit server rather than a
Node shim:

```sh
pnpm --filter @statewalker/webrun-streams-livekit test:browser
```

with the `WEBRUN_STREAMS_LIVEKIT_*` environment variables pointing at a running
server. The package's dev dependencies include `testcontainers` and
`livekit-server-sdk` for standing one up.

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |
| `livekit-client` | **peer** (`^2.18.3`) | You supply and own the `Room`. |
| `livekit-server-sdk`, `testcontainers` | dev | Token minting and a containerised server for conformance. |

ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
