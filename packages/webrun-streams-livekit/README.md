# @statewalker/webrun-streams-livekit

## What it is

A `Connect` / `Serve` adapter that runs `@statewalker/webrun-streams` `Duplex` calls over a LiveKit
room. A connected `Room` plus the identity of one remote participant becomes one `ByteChannel`
(reliable data packets addressed to that participant), and `webrun-streams`' `emulateMux` runs
many concurrent calls over it. Your handler is an ordinary `Duplex`,
`(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>`, the same function you would
run over a WebSocket or a WebRTC data channel.

## Why it exists

Direct peer-to-peer links fail behind symmetric NATs, corporate firewalls and some mobile
networks, and multi-party sessions want a server anyway. LiveKit is a managed SFU that already
handles authentication, room membership and presence. What its data channel does not provide is
request semantics: there are no calls, no streams, no flow control, only packets. This adapter
adds them, so code written against the `Duplex` seam can move from a direct link to a LiveKit room
by changing the `connect` / `serve` import, with handlers and the layers above them unchanged.

## How to use

```sh
pnpm add @statewalker/webrun-streams-livekit livekit-client
```

`livekit-client` is a required peer dependency (`^2.18.3`). You create the `Room`, get its token,
connect it and disconnect it; this package never does. Browser only, because `livekit-client` is.
One entry point, `.`, ESM only.

| Export | Purpose |
| --- | --- |
| `connect(params: LiveKitParams)` | `Connect<LiveKitParams>`. Resolves `{ call, close }`; each `call(input)` opens a new logical stream to `peerIdentity`. `close()` ends the mux, not the `Room`. |
| `serve(params: LiveKitParams, handler)` | `Serve<LiveKitParams>`. Runs `handler` for every stream `peerIdentity` opens. Resolves an idempotent teardown. |
| `LiveKitParams` | `{ room: Room; peerIdentity: string; mux?: EmulateMuxOptions }`. |
| `byteChannelFromLiveKit(room, peerIdentity)` | The `ByteChannel` both use, for driving `emulateMux` yourself. |
| `messageTargetOverLiveKit(room, peerIdentity, options?)` | **The port stack (Plan C2).** One remote participant as `{ target, signal, maxMessageSize }`: a `MessageTarget` of bytes (one reliable packet each) with `bufferedAmount` / `whenDrained()`, a signal that aborts when the room disconnects, the participant leaves or a publish fails, and the payload ceiling to give `overPipe`. See below. |
| `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_MESSAGE_SIZE`, `DRAIN_LOW_WATER` | 64,000 bytes, 12 KiB, 256 KiB: the defaults of the above. |
| `DEFAULT_TOPIC`, `CLOSE_TOPIC` | The data topic (`webrun/port-stack`) and the goodbye's (`webrun/port-stack/close`); `options.topic` changes both. |

`mux` is forwarded to `emulateMux`: `mtu` (default here 12 KiB, see below), `maxStreamBuffer`
(per-stream inbound cap and advertised credit; `webrun-streams` default 8 MiB), `maxStreams`
(default 256). `side` is fixed by the function you call — `"initiator"` for `connect`,
`"responder"` for `serve` — and overrides `mux.side`.

## Examples

Both sides take a connected `Room` and the identity of the participant at the other end.

### Serving

```ts
import { Room } from "livekit-client";
import { serve } from "@statewalker/webrun-streams-livekit";

const room = new Room();
await room.connect(url, token); // this participant's identity is "agent-7"

const stop = await serve({ room, peerIdentity: "client-3" }, async function* echo(input) {
  for await (const chunk of input) yield chunk;
});

// later
await stop();
```

### Calling

```ts
import { Room } from "livekit-client";
import { connect } from "@statewalker/webrun-streams-livekit";

const room = new Room();
await room.connect(url, token); // this participant's identity is "client-3"

const { call, close } = await connect({ room, peerIdentity: "agent-7" });

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close();
```

### HTTP over the room

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/events"));
```

### The port stack over a room

`connect` / `serve` above run `emulateMux`, which goes away in Plan C3. Its
replacement is `webrun-rpc`'s port stack: the participant pair is one pipe,
`overPipe` invents a port per call, and a producer stays at most one chunk ahead
of its consumer.

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { messageTargetOverLiveKit } from "@statewalker/webrun-streams-livekit";

const { target, signal, maxMessageSize } = messageTargetOverLiveKit(room, "agent-7");
const { call, close } = await connect({
  mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
});
```

The other participant does the same with `side: "responder"` and `webrun-rpc`'s
`serve`. Pass all three: `signal` closes the multiplexer when the room or the
participant goes, and `maxMessageSize` (12 KiB, as this adapter has always used
against a real SFU) chunks bodies.

- The participant must already be in the room, or this throws: LiveKit drops
  packets to a participant it has not announced, and nothing would end the pipe.
- Packets carry their own topic, and inbound packets on any other topic (an
  application's own `publishData`) are ignored.
- A post past `maxFrameBytes` (64,000 bytes, livekit-client's own cap, which it
  enforces by throwing) ends the pipe with a `RangeError`; a failed reliable
  publish ends it too, since the stream above has lost a message.
- Ending on this side (`close()`, an oversized post, a failed publish) sends a
  goodbye on the close topic, which ends the peer's pipe: the room stays
  connected, so no LiveKit event would tell it.
- `bufferedAmount` counts bytes whose `publishData` has not settled, and
  `whenDrained()` resolves once that is at most 256 KiB. `close()` detaches from
  the room and leaves it connected.

### Driving the mux yourself

```ts
import { emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromLiveKit } from "@statewalker/webrun-streams-livekit";

const channel = byteChannelFromLiveKit(room, "agent-7");
const mux = emulateMux(channel, { mtu: 12 * 1024, side: "initiator" });
// mux.call(input), mux.serve(handler), mux.close()
```

## Internals

```
 handler / caller (Duplex)
          │
   emulateMux (webrun-streams): [varint streamId][1-byte type] frames, credit flow control
          │
   byteChannelFromLiveKit: one ByteChannel per (room, peerIdentity)
          │  out: publishData(bytes, { reliable: true, destinationIdentities: [peerIdentity] })
          │  in:  "dataReceived" events, filtered by sender identity
          ▼
   LiveKit SFU
```

### Why every publish is reliable and addressed

Every packet is published with `reliable: true` (ordered and retransmitted), because the mux
framing above assumes an ordered byte stream. Every packet carries `destinationIdentities:
[peerIdentity]`, so several pairs in one room do not fan out to every participant. Inbound packets
from any other identity are ignored, so one `Room` can carry several adapters, one per peer.

### Why the default `mtu` is 12 KiB

A LiveKit reliable data packet is capped at about 15 KiB, and a larger payload is dropped rather
than fragmented. `emulateMux`'s own 64 KiB default therefore fails here, and silently: a 1 MiB body
arrives as zero bytes and a 10 MiB body never completes, with no error on either side. So
`connect` and `serve` default `mtu` to 12 KiB, which leaves room for the frame header inside the
packet. An explicit `mux.mtu` still wins, for a deployment that allows larger packets.

### What closes the channel, and what you see

The channel closes when the `Room` emits `disconnected`, when the `peerIdentity` participant
disconnects (`participantDisconnected`), or when its `close()` is called. In-flight and later calls
then fail with `webrun-streams`' `TransportClosedError` (`name` `"TransportClosedError"`). `serve`
also closes its mux when the channel closes. The channel does not reopen: if the peer leaves and
comes back, call `connect` / `serve` again.

A failed `publishData` is swallowed; it surfaces through the disconnect events, not as an error on
the call.

### Two things that are easy to get wrong

- **Wait for the peer to be in the room before the first call.** The adapter addresses the remote
  by identity, and LiveKit drops a data packet sent to a participant it has not announced yet
  rather than queueing it. Wait for `RoomEvent.ParticipantConnected` (or check
  `room.remoteParticipants`) first.
- **Each side names the other side's identity, exactly.** A wrong identity is not an error:
  packets are filtered out and the call waits.

### Conformance runs in a browser against a real server

```sh
pnpm --filter @statewalker/webrun-streams-livekit test:browser
```

This runs the `@statewalker/webrun-streams-conformance` suite in headless Chromium through
Playwright. A Vitest global setup starts `livekit-server --dev` on a loopback port and mints the
two access tokens with `livekit-server-sdk`, so the `livekit-server` binary must be on `PATH`.
Without it the setup fails with `livekit-server exited early (code …). Install it from
https://docs.livekit.io/home/self-hosting/local/`. Under plain `pnpm test` (Node) the suite is
skipped, because `livekit-client` needs a browser.

### Dependencies

- `@statewalker/webrun-streams` (runtime): the `Duplex` / `Connect` / `Serve` / `ByteChannel`
  types and `emulateMux`.
- `livekit-client` (peer): you supply and own the `Room`.
- Dev only: `livekit-server-sdk` for test tokens, `@vitest/browser-playwright` and `playwright`
  for the browser run, `@statewalker/webrun-streams-conformance` for the suite.

## License

MIT
