# @statewalker/webrun-streams-livekit

## What it is

One remote participant of a LiveKit room as a pipe of bytes for `@statewalker/webrun-rpc`'s port
stack. `messageTargetOverLiveKit(room, peerIdentity)` turns a connected `Room` plus the identity of
the participant at the other end into `{ target, signal, maxMessageSize }`: a `MessageTarget` whose
messages are `Uint8Array`s (one reliable data packet each, addressed to that participant), a
signal that aborts when the room or the participant goes, and the payload ceiling to chunk to.
Hand all three to `webrun-rpc`'s `overPipe` with `msgpackCodec`, and `webrun-rpc`'s `connect` /
`serve` run many concurrent calls over the pair, one port per call. Your handler is an ordinary
`Duplex`, `(input: AsyncIterable<Uint8Array>) => AsyncGenerator<Uint8Array>`, the same function
you would run over a WebSocket or a WebRTC data channel.

## Why it exists

Direct peer-to-peer links fail behind symmetric NATs, corporate firewalls and some mobile
networks, and multi-party sessions want a server anyway. LiveKit is a managed SFU that already
handles authentication, room membership and presence. What its data channel does not provide is
request semantics: there are no calls, no streams, no flow control, only packets. `webrun-rpc`'s
port stack adds those over any pipe of messages. What it needs from the transport is a pipe to one
peer, word of that pipe's end, and the largest message that crosses. A room is shared, stays
connected when one pipe ends, and caps packet size; this package addresses packets to one
participant on their own topic, turns room and participant events (and its own goodbye packet)
into the signal, and reports a safe ceiling. Code written against the `Duplex` seam moves from a
direct link to a LiveKit room by changing the pipe, with handlers and the layers above unchanged.

## How to use

```sh
pnpm add @statewalker/webrun-streams-livekit livekit-client @statewalker/webrun-rpc @statewalker/webrun-msgpack
```

`livekit-client` is a required peer dependency (`^2.18.3`). You create the `Room`, get its token,
connect it and disconnect it; this package never does. Browser only, because `livekit-client` is.
One entry point, `.`, ESM only.

| Export | Purpose |
| --- | --- |
| `messageTargetOverLiveKit(room, peerIdentity, options?)` | One remote participant as a `LiveKitMessageTarget`, `{ target, signal, maxMessageSize }`: a `MessageTarget` of bytes (one reliable packet each) with `bufferedAmount` / `whenDrained()`, a signal that aborts when the room disconnects, the participant leaves, the peer closes its pipe, a publish fails or a post exceeds `maxFrameBytes`, and the payload ceiling to give `overPipe`. |
| `MessageTargetOverLiveKitOptions` | `maxFrameBytes` (default `DEFAULT_MAX_FRAME_BYTES`), `maxMessageSize` (default `DEFAULT_MAX_MESSAGE_SIZE`), `topic` (default `DEFAULT_TOPIC`; both ends must agree; use another to run two pipes to the same participant). |
| `LiveKitMessageTarget` | The result type above. |
| `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_MESSAGE_SIZE`, `DRAIN_LOW_WATER` | 64,000 bytes, 12 KiB, 256 KiB: the defaults of the above. |
| `DEFAULT_TOPIC`, `CLOSE_TOPIC` | The data topic (`webrun/port-stack`) and the goodbye's (`webrun/port-stack/close`); `options.topic` changes both (the goodbye uses it with `/close` appended). |

Both ends must run the port stack with the same codec and topic. Pass all three of `target`,
`signal` and `maxMessageSize` to `overPipe`: `signal` closes the multiplexer when the room or the
participant goes, and `maxMessageSize` chunks bodies under the packet limit.

## Examples

Both sides take a connected `Room` and the identity of the participant at the other end.

### Serving

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { overPipe, serve } from "@statewalker/webrun-rpc";
import { messageTargetOverLiveKit } from "@statewalker/webrun-streams-livekit";
import { Room } from "livekit-client";

const room = new Room();
await room.connect(url, token); // this participant's identity is "agent-7"
// ...once "client-3" is in the room:

const { target, signal, maxMessageSize } = messageTargetOverLiveKit(room, "client-3");
const stop = await serve(
  { mux: overPipe(target, { codec: msgpackCodec, side: "responder", signal, maxMessageSize }) },
  async function* echo(input) {
    for await (const chunk of input) yield chunk;
  },
);

// later
await stop();
```

### Calling

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe } from "@statewalker/webrun-rpc";
import { messageTargetOverLiveKit } from "@statewalker/webrun-streams-livekit";
import { Room } from "livekit-client";

const room = new Room();
await room.connect(url, token); // this participant's identity is "client-3"
// ...once "agent-7" is in the room:

const { target, signal, maxMessageSize } = messageTargetOverLiveKit(room, "agent-7");
const { call, close } = await connect({
  mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
});

for await (const chunk of call([new TextEncoder().encode("ping")])) {
  console.log(new TextDecoder().decode(chunk)); // "ping"
}

await close(); // the Room stays connected
```

### HTTP over the room

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";

const response = await fetchOverDuplex(call, new Request("http://peer/api/events"));
```

## Internals

```
 handler / caller (Duplex)
          │
   webrun-rpc connect / serve: one stream per port
          │
   overPipe + msgpackCodec (webrun-rpc): a port per call, framing, chunking to maxMessageSize
          │
   messageTargetOverLiveKit: one MessageTarget per (room, peerIdentity, topic)
          │  out: publishData(bytes, { reliable: true, destinationIdentities: [peerIdentity], topic })
          │  in:  "dataReceived" events, filtered by sender identity and topic
          ▼
   LiveKit SFU
```

### Why every publish is reliable, addressed and on its own topic

Every packet is published with `reliable: true` (ordered and retransmitted), because the
multiplexer above assumes ordered delivery. Every packet carries `destinationIdentities:
[peerIdentity]`, so several pairs in one room do not fan out to every participant, and its own
topic, so an application's own `publishData` traffic does not reach the multiplexer. Inbound
packets from any other identity or on any other topic are ignored, so one `Room` can carry several
pipes, one per peer (or per topic). Each packet is copied before `publishData`, since
livekit-client serializes it after an await; each inbound packet is copied into a fresh
`Uint8Array`.

### Why the ceiling is 12 KiB

livekit-client (2.x) refuses a data packet over 64,000 bytes with a `PublishDataError`; a post
past `maxFrameBytes` (that cap by default) ends the pipe with a `RangeError` before it gets that
far. The reported `maxMessageSize` is lower, 12 KiB, as this adapter has always used against a
real SFU: an older client dropped larger reliable packets silently, a body arriving as zero bytes
with no error on either side. 12 KiB leaves room for the port stack's framing well inside the
packet cap. Raise it with `options.maxMessageSize` (keeping it at least 256 bytes under the packet
limit) only for a deployment known to allow more.

### What closes the pipe, and what you see

`signal` aborts when the `Room` emits `disconnected`, when the `peerIdentity` participant
disconnects (`participantDisconnected`), when the peer's goodbye arrives on the close topic, when a
reliable publish fails (the stream above has lost a message), on an oversized post, or on
`close()`. `overPipe` closes the multiplexer on it, which fails every call in flight. The pipe does
not reopen: if the peer leaves and comes back, call `messageTargetOverLiveKit` again.

Ending on this side (`close()`, an oversized post, a failed publish) sends a goodbye, an empty
packet on the close topic, which ends the peer's pipe: the room stays connected, so no LiveKit
event would tell it. `close()` detaches from the room and leaves it connected.

`bufferedAmount` counts bytes whose `publishData` has not settled, and `whenDrained()` resolves
once that is at most `DRAIN_LOW_WATER`, or the pipe ended. `postMessage` throws a `TypeError` for
anything but bytes, and is a no-op once the pipe has ended: `signal` already says so.

### Two things that are easy to get wrong

- **Wait for the peer to be in the room first.** The pipe addresses the remote by identity, and
  LiveKit drops a data packet sent to a participant it has not announced yet rather than queueing
  it, so `messageTargetOverLiveKit` throws `messageTargetOverLiveKit: "<identity>" is not in the
  room; wait for it to join`. Wait for `RoomEvent.ParticipantConnected` (or check
  `room.remoteParticipants`) first.
- **Each side names the other side's identity, exactly, and the same topic.** A wrong identity or
  topic is not an error: packets are filtered out and the call waits.

### Conformance runs in a browser against a real server

```sh
pnpm --filter @statewalker/webrun-streams-livekit test:browser
```

This runs the `@statewalker/webrun-streams-conformance` suite in headless Chromium through
Playwright, over the port stack (`overPipe` + `msgpackCodec`). The pair ignores `PairTuning`, as
every port-stack pair does, so L6 is an integrity check until D17 redefines it. A Vitest global
setup starts `livekit-server --dev` on a loopback port and mints the two access tokens with
`livekit-server-sdk`, so the `livekit-server` binary must be on `PATH`. Without it the setup fails
with `livekit-server exited early (code …). Install it from
https://docs.livekit.io/home/self-hosting/local/`. Under plain `pnpm test` (Node) the suite is
skipped, because `livekit-client` needs a browser. `message-target.test.ts` pins the pipe's
contract.

### Dependencies

- `livekit-client` (peer): you supply and own the `Room`. `src/` imports only its `Room` type.
- Nothing from this repository at runtime: the target is a `MessageTarget` by shape.
  `@statewalker/webrun-rpc`, `@statewalker/webrun-msgpack` and `@statewalker/webrun-streams` are
  dev dependencies of the tests; consumers supply their own `webrun-rpc` and codec.
- Dev only: `livekit-server-sdk` for test tokens, `@vitest/browser-playwright` and `playwright`
  for the browser run, `@statewalker/webrun-streams-conformance` for the suite.

## License

MIT
