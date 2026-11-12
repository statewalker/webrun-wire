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
transport and this adapter needs no multiplexer over it. What an
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
| `webrtcPortMux(options)` | Native MessagePorts: a `webrun-rpc` `PortMux` (by shape) whose every port is its own data channel (labelled `webrun-port/…`), for `overPorts`. `options`: `pc`, `codec` (a value codec: `{ encode: serialize, decode: deserialize }` from `webrun-msgpack`), `onPort(port)` (to accept ports), `maxMessageSize`, `maxFrameBytes`. See "MessagePorts over WebRTC" below. |
| `DEFAULT_PORT_MAX_FRAME_BYTES`, `DEFAULT_PORT_MAX_MESSAGE_SIZE`, `PORT_DRAIN_LOW_WATER`, `PORT_LABEL_PREFIX` | 16 KiB, 16 KiB − 256, 256 KiB, `"webrun-port/"`. |

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

DATA   0x00  body bytes, at most 16 KiB - 1 per message
END    0x01  this side has finished sending (half-close)
ERROR  0x02  JSON of serializeError(err): message, stack, custom fields
CREDIT 0x03  big-endian u32: payload bytes the receiver's consumer pulled
```

### Flow control

Two limits keep memory bounded whatever the speed of either side:

- **Send buffer.** Before each `DATA` message the sender waits while the
  channel holds more than `HIGH_WATER_MARK` (1 MiB) unsent
  (`bufferedAmount`), until `bufferedamountlow` fires at `LOW_WATER_MARK`
  (256 KiB).
- **Receive window.** A sender may have at most `RECEIVE_WINDOW` (4 MiB) of
  payload outstanding that the receiving consumer has not pulled. The receiver
  returns credit with `CREDIT` frames as its consumer pulls, half a window at a
  time. On the responder, the next chunk is pulled only once the handler took
  the previous one, so a slow handler stalls the caller.

Both ends must speak `CREDIT`: a sender facing a peer that never returns
credit stops after the first window.

Each side keeps listening for `CREDIT` until both directions are done, so a
reply larger than the window, sent after the input ended, still flows. When
the responder's handler finishes (or throws) without reading all its input,
the rest of the caller's upload is read and dropped, so the caller's upload
finishes rather than waiting for credit. A caller that cancels, or gets an
error, stops its own upload and closes the channel at once.

A finished call's channel is closed by the caller, once it has the
responder's `END` or `ERROR`: a responder that closed right after sending them
could lose them in flight. Each side also holds the frames that arrive before
its stream starts listening, so a responder that answers at once (a handler
that throws, a reply with no input to wait for) is not faster than the
caller's listener.

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

### MessagePorts over WebRTC, and the port stack on them

`connect` / `serve` above run their own framing and credit window per data
channel, so a consumer that stops reading lets its producer get up to 4 MiB
ahead (L6). `webrtcPortMux` gives `webrun-rpc`'s port stack a data channel per
port instead, and its stream tier keeps a producer within one confirmed chunk:

```ts
import { deserialize, serialize } from "@statewalker/webrun-msgpack";
import { connect, overPorts, serve } from "@statewalker/webrun-rpc";
import { webrtcPortMux } from "@statewalker/webrun-streams-webrtc";

const codec = { encode: serialize, decode: deserialize };
await serve({ mux: overPorts((onPort) => webrtcPortMux({ pc, codec, onPort })) }, handler);
const { call } = await connect({ mux: overPorts(() => webrtcPortMux({ pc: other, codec })) });
```

Ports are ordered, reliable channels labelled `webrun-port/…`; a mux ignores
inbound channels without that label, and this package's `serve()` ignores
channels with it, so ports share a connection with `connect` / `serve` and with
anyone else's channels. On one connection, a mux without `onPort` (a caller's)
leaves inbound ports to the serving mux, so both directions can call; of
several serving muxes, the first takes each port. Each message is one
data channel message, so `maxMessageSize` defaults to 16 KiB − 256 (Firefox to
Chrome cuts off at 16 KiB; the port stack's framing needs the margin), and a
message past `maxFrameBytes` fails the port with a `RangeError` instead of
being dropped. Each port carries `closeSignal`, aborted when its channel closes
or errs, the connection becomes `failed` or `closed`, or the port is closed
here. A refused port (`onPort` returning `false`) is closed, so the opener's
call fails. Messages that arrive before a port's first listener are held for
it, delivered after that tick to every listener added by then. A connection
that has failed already makes `openPort` reject, as does an aborted `signal`.
`whenDrained()` waits on `bufferedamountlow` (256 KiB). The suite runs a
second conformance pair over these ports (`tests/port-mux.test.ts`), with L6 at
a one-chunk bound.

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

- Conformance and the flow-control tests (100 MiB under the high-water mark;
  a sleeping reader stalls the sender within the window) run in Chromium
  through Playwright: `pnpm run test:browser`, also in CI.
  Under `pnpm test` (Node) the suite is registered as skipped, because Node
  has no `RTCPeerConnection`. L6 asserts the per-channel window: a consumer
  that stops reading lets the producer get at most `RECEIVE_WINDOW` (4 MiB)
  ahead, measured at exactly that.

### Dependencies

- `@statewalker/webrun-streams` (`workspace:^`): `toChunks`,
  `serializeError` / `deserializeError`, `TransportClosedError` and the seam
  types.
- No other runtime dependencies and no peer dependencies.

## License

MIT
