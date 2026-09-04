# @statewalker/webrun-streams-peerjs

PeerJS `DataConnection`-backed `Connect` / `Serve` adapter in the
`webrun-streams-*` family.

## What this is

A binding between a PeerJS [`DataConnection`](https://peerjs.com/docs/#dataconnection)
and the [`webrun-streams`](../webrun-streams) `Duplex` seam. One
`DataConnection` becomes one `ByteChannel`; `emulateMux` layers many concurrent
logical calls on top of it.

Your handler is an ordinary `Duplex` —
`(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>` — identical
to the one you would run over a WebSocket or a `MessagePort`.

## Why it exists

PeerJS is the least-effort route to a browser-to-browser connection: it ships a
public broker, so you get a working peer link without standing up signalling
infrastructure. What it hands you afterwards is a single message pipe with no
request framing, no concurrency, no half-close, and no error propagation.

This adapter supplies those once, so the transport becomes an implementation
detail — prototype over PeerJS's public broker, then move the same handler to
[`webrun-streams-webrtc`](../webrun-streams-webrtc) or
[`webrun-streams-libp2p`](../webrun-streams-libp2p) for production without
touching it.

## Install

```sh
npm install @statewalker/webrun-streams-peerjs peerjs
```

`peerjs` is a **peer dependency** (`^1.5.5`) — you own the `Peer` instance and
its broker configuration.

> [!IMPORTANT]
> Connections must be opened with `serialization: "raw"`. PeerJS otherwise
> applies its own encoding to your bytes and the framing will not survive.

## Getting started

Responder — listen for inbound connections on a connected `Peer`:

```ts
import Peer from "peerjs";
import { serve } from "@statewalker/webrun-streams-peerjs";

const peer = new Peer("my-server-id");
await new Promise((r) => peer.on("open", r));

const stop = await serve({ peer }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});
```

Caller — connect, then hand the open `DataConnection` to the adapter:

```ts
import Peer from "peerjs";
import { connect } from "@statewalker/webrun-streams-peerjs";

const peer = new Peer();
const conn = peer.connect("my-server-id", { serialization: "raw" });
await new Promise((r) => conn.on("open", r));

const { call, close } = await connect({ conn });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
```

Note the asymmetry: `serve` takes the `Peer` (it accepts many inbound
connections), `connect` takes one already-open `DataConnection`.

### Carrying HTTP over it

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/todo"));
```

## API

### `connect(params): Promise<{ call, close }>`

Type: `Connect<ConnectPeerJsParams>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `conn` | `DataConnection` | An already-open connection with `serialization: "raw"`. |

Each `call(input)` opens a new logical stream over that connection. `close()`
tears down the streams and the channel.

### `serve(params, handler): Promise<() => Promise<void>>`

Type: `Serve<ServePeerJsParams>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `peer` | `Peer` | A connected peer; the adapter listens for inbound `DataConnection`s. |

Returns an idempotent teardown.

### `byteChannelFromPeerJs(conn): ByteChannel`

Wraps one `DataConnection` as a `ByteChannel` (`send` / `recv` / `closed` /
`close`) for driving `emulateMux` yourself.

### `ConnectPeerJsParams` / `ServePeerJsParams`

The two parameter types above.

## Conformance

Runs [`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance)
against a local broker (the [`peer`](https://www.npmjs.com/package/peer) server).

The suite is **browser-gated**. `@roamhq/wrtc` covers the WebRTC primitives in
Node, but the full PeerJS handshake hangs there, so
`tests/conformance.test.ts` registers the suite only when a `window` global is
present; the plain Node run reports it as skipped.

```sh
pnpm --filter @statewalker/webrun-streams-peerjs test:browser   # runs the suite
pnpm --filter @statewalker/webrun-streams-peerjs test           # reports it skipped
```

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` / `ByteChannel` seam and `emulateMux`. |
| `peerjs` | **peer** (`^1.5.5`) | You supply and own the `Peer`. |
| `peer`, `@roamhq/wrtc` | dev | Local broker and WebRTC for the conformance run. |

ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
