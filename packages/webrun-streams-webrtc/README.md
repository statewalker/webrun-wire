# @statewalker/webrun-streams-webrtc

WebRTC `Connect` / `Serve` adapter in the `webrun-streams-*` family, with
**native multi-stream** — one `RTCDataChannel` per logical call.

## What this is

A binding between an `RTCPeerConnection` and the
[`webrun-streams`](../webrun-streams) `Duplex` seam. Your handler is an
ordinary `Duplex` —
`(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>` — and this
package carries it directly between two browsers with no server in the data
path.

Unlike the message-oriented adapters (WebSocket, MessagePort, LiveKit, PeerJS),
this one does **not** use `emulateMux`. WebRTC can open as many data channels as
you want, so each `call(input)` opens its own `RTCDataChannel` and the responder
picks it up via `pc.ondatachannel`. Concurrency is the transport's, not
emulated.

## Why it exists

`RTCDataChannel` is a good byte pipe with two gaps that every user hits:

1. **No half-close.** A channel is open or closed; there is no way to say
   "I'm done sending, keep receiving". Request/response needs exactly that.
2. **No error channel.** If the far end throws, the near end sees a closed
   channel and no reason.

This adapter closes both gaps with a one-byte frame header inside each data
channel message:

| Byte | Frame | Payload |
| --- | --- | --- |
| `0x00` | `DATA` | body bytes |
| `0x01` | `END` | — (half-close) |
| `0x02` | `ERROR` | serialised `Error` (message, stack, custom fields) |

Outbound bytes are chunked at 16 KiB to stay inside the SCTP message limits
that browsers enforce.

## Install

```sh
npm install @statewalker/webrun-streams-webrtc
```

No peer dependencies. In the browser `RTCPeerConnection` is built in; in Node
tests it is supplied by [`@roamhq/wrtc`](https://www.npmjs.com/package/@roamhq/wrtc).

## Getting started

**Signalling, auth and connection setup are the caller's responsibility.** This
package takes an already-open `RTCPeerConnection` and does nothing else. If you
need signalling too, see
[`@statewalker/webrun-streams-signaling`](../webrun-streams-signaling), which
produces connected peers for you.

Responder side — register a handler:

```ts
import { serve } from "@statewalker/webrun-streams-webrtc";

const stop = await serve({ pc }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});
```

Caller side — open calls over the same peer connection:

```ts
import { connect } from "@statewalker/webrun-streams-webrtc";

const { call, close } = await connect({ pc });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
```

### Concurrent calls

Every `call(...)` gets its own data channel, so calls are genuinely parallel:

```ts
import { collectBytes } from "@statewalker/webrun-streams";

const [a, b] = await Promise.all([
  collectBytes(call(requestA)),
  collectBytes(call(requestB)),
]);
```

### Carrying HTTP over it

Pair with [`webrun-http-streams`](../webrun-http-streams) to exchange real
`Request` / `Response` objects — including streaming bodies and SSE — directly
between two browsers:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/events"));
```

See [`apps/p2p-demo`](../../apps/p2p-demo) for this running end to end.

## API

### `connect(params): Promise<{ call, close }>`

Type: `Connect<WebRtcParams>`.

| Field | Type | Meaning |
| --- | --- | --- |
| `pc` | `RTCPeerConnection` | An already-open peer connection. |

Each `call(input)` opens a fresh `RTCDataChannel`. `close()` tears down the
adapter's channels; it does not close `pc`, which you own.

### `serve(params, handler): Promise<() => Promise<void>>`

Type: `Serve<WebRtcParams>`. Listens on `pc.ondatachannel` and runs `handler`
for each inbound channel. Returns an idempotent teardown.

### `duplexOverDataChannel(channel, options?): Duplex`

The lower-level primitive: wraps a single `RTCDataChannel` as one `Duplex`,
implementing the DATA/END/ERROR framing described above. Use it when you manage
channel creation yourself.

### `WebRtcParams`

The parameter type shared by `connect` and `serve`.

## Conformance

Passes [`@statewalker/webrun-streams-conformance`](../webrun-streams-conformance)
against a Node `@roamhq/wrtc` peer pair — concurrency, half-close, mid-stream
cancellation, error propagation and idempotent teardown.

```sh
pnpm --filter @statewalker/webrun-streams-webrtc test
```

## Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](../webrun-streams) | runtime | The `Duplex` seam and error serialisation. |
| `@roamhq/wrtc` | dev | `RTCPeerConnection` for the Node conformance run. |

No runtime dependencies outside the workspace. ESM only (`"type": "module"`).

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
