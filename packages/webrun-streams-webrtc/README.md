# @statewalker/webrun-streams-webrtc

## What it is

A WebRTC adapter for the `Duplex` seam from `@statewalker/webrun-streams`. It
takes an already-connected `RTCPeerConnection`. `connect` returns a `call`
function that opens one new `RTCDataChannel` per call; `serve` runs a handler
for every data channel the peer opens. The handler is an ordinary `Duplex`
(`(input) => AsyncGenerator<Uint8Array>`), and the bytes travel directly
between the two peers with no server in the data path.

## Why it exists

WebRTC can open as many data channels as needed, so concurrency comes from the
transport and this adapter does not use `emulateMux`. What an
`RTCDataChannel` lacks is what request/response needs:

1. **No half-close.** A channel is open or closed. There is no way to say "I
   have finished sending, keep receiving".
2. **No error channel.** When the far end throws, the near end sees a closed
   channel and no reason.

The adapter adds both with a one-byte frame type inside each data channel
message, and maps cancellation onto closing the channel.

## How to use

```sh
pnpm add @statewalker/webrun-streams-webrtc
```

Runtime dependency: `@statewalker/webrun-streams`. No peer dependencies. One
entry point, `.`. It needs `RTCPeerConnection`, so it runs in browsers; in
Node it needs a WebRTC implementation that provides the same API.

Signalling, authentication and connection setup are the caller's job. Pass a
connection that is already `connected` and whose SDP negotiated a data
channel (SCTP) section; see "What the peer connection must already have"
below.

| Export | What it gives |
| --- | --- |
| `connect({ pc })` | `Connect<WebRtcParams>`. Resolves `{ call, close }`. Each `call(input)` opens a new `RTCDataChannel` on `pc`, waits for it to open and runs the call over it. `close()` closes the channels this `connect` opened; it does not close `pc`. |
| `serve({ pc }, handler)` | `Serve<WebRtcParams>`. Listens for `datachannel` events on `pc` and runs `handler` on each channel. Resolves to an idempotent teardown that stops accepting new channels; calls in flight continue. |
| `duplexOverDataChannel(dc, input)` | The primitive under both: runs one call over one data channel. Sends `input` framed, and returns an `AsyncGenerator<Uint8Array>` of the peer's bytes. |
| `WebRtcParams` | `{ pc: RTCPeerConnection }`. |

## Examples

### Responder

```ts
import { serve } from "@statewalker/webrun-streams-webrtc";

declare const pc: RTCPeerConnection; // connected, negotiated by your signalling

const stop = await serve({ pc }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});
// later
await stop();
```

### Caller, with concurrent calls

```ts
import { collectBytes } from "@statewalker/webrun-streams";
import { connect } from "@statewalker/webrun-streams-webrtc";

declare const pc: RTCPeerConnection;

const { call, close } = await connect({ pc });
const enc = new TextEncoder();

// Each call gets its own data channel, so these run in parallel.
const [a, b] = await Promise.all([
  collectBytes(call([enc.encode("first")])),
  collectBytes(call([enc.encode("second")])),
]);

await close(); // pc stays open; you own it
```

### HTTP between two browsers

`@statewalker/webrun-http-streams` carries `Request` / `Response`, including
streaming bodies, over any `Duplex`:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-webrtc";

declare const pc: RTCPeerConnection;

const { call } = await connect({ pc });
const response = await fetchOverDuplex(call, new Request("http://peer/api/events"));
```

### One call over a channel you created

```ts
import { duplexOverDataChannel } from "@statewalker/webrun-streams-webrtc";

declare const dc: RTCDataChannel; // open, with a peer running duplexOverDataChannel too

async function* request() {
  yield new TextEncoder().encode("ping");
}
for await (const chunk of duplexOverDataChannel(dc, request())) {
  console.log(new TextDecoder().decode(chunk));
}
```

## Internals

### Frames inside a data channel

```
+--------+---------------------------+
| type   | payload                   |
| 1 byte | rest of the message       |
+--------+---------------------------+

DATA  0x00  body bytes, at most 16 KiB - 1 per message
END   0x01  this side has finished sending (half-close)
ERROR 0x02  JSON of serializeError(err): message, stack, custom fields
```

```
caller                          responder
  | createDataChannel("webrun/…")  |  datachannel event -> handler(input)
  | DATA, DATA, … END  ----------> |  handler's input ends
  |  <------------- DATA, … END    |  handler's output ends
  | both sides ended: dc.close()   |
```

Outbound chunks are split with `toChunks` so each message, with its type byte,
is at most 16 KiB, a size that every browser's SCTP implementation accepts. The
channel's `binaryType` is set to `"arraybuffer"`; text messages and empty
messages are ignored. The channel is closed once both directions have ended.

### How cancellation reaches the handler

`END` means "I am done sending", and the peer answers it by carrying on, so it
cannot express "stop". When the caller leaves early (`.return()` on the call's
generator, or an error), `duplexOverDataChannel` waits for its own outbound
pump to settle and then closes the channel. On the responder, the channel's
`close` event ends the inbound side with `TransportClosedError`, which closes
the handler's input and runs the handler's `finally`.

On a normal finish the outbound pump is not awaited. The responder feeds the
handler's input from this generator and closes that input only when the
generator returns; awaiting the pump there would wait for the handler, which
waits for its input, which waits for the generator.

### What the peer connection must already have

An offer contains a data channel section only if the connection already has a
data channel when the offer is created. Without that section SCTP is never
negotiated and every channel `connect` opens stays in `connecting`, so `call`
never starts. Create a data channel before the first offer.

`serve` treats every channel the peer opens on `pc` as a call, whatever its
label (`connect` labels its channels `webrun/<time>/<counter>`). Channels the
application opens for other purposes, including one created only to shape the
SDP, must be opened before `serve` is registered or on a different connection.

### Failure modes

| Situation | Error |
| --- | --- |
| `call` after `close()`, or after `pc` became `closed` or `failed` | `webrun-streams-webrtc: connection closed` (a plain `Error`) |
| Channel closes before it opens | `DataChannel closed before open` |
| Channel error before it opens | `DataChannel error: <message or "unknown">` |
| Channel closes before the peer sent `END` | `TransportClosedError` (`transport closed`) |
| Handler throws | The caller's `for await` throws the deserialised error, with `message`, `stack` and custom fields |

On the responder, a channel task that fails (usually a caller that cancelled)
is caught, so it does not become an unhandled rejection.

### Constraints

- **No flow control in the adapter.** Outbound messages go to `dc.send` as
  fast as `input` yields; `bufferedAmount` is not checked, and the inbound
  queue is not bounded. Very large or fast bodies rely on the browser's send
  buffer, which closes the channel when it overflows.
- Conformance runs in Chromium through Playwright: `pnpm run test:browser`.
  Under `pnpm test` (Node) the suite is registered as skipped, because Node
  has no `RTCPeerConnection`. L6's small window does not apply here (there is
  no `emulateMux`), so L6 is an integrity check.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): `toChunks`,
  `serializeError` / `deserializeError`, `TransportClosedError` and the seam
  types.
- No other runtime dependencies and no peer dependencies.

## License

MIT
