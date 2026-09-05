# @statewalker/webrun-ports

Turn one message port into many.

A `PortMux` takes a single port and hands out virtual ones. Each virtual port is
itself a `MessageTarget` — the same shape as a `MessagePort` — so whatever runs
on top cannot tell a virtual port from a real one, and a multiplexer can even run
over another multiplexer's port.

## Why it exists

Multiplexing keeps getting rebuilt at the wrong layer. A transport that offers
one pipe needs streams multiplexed over it; a transport that already multiplexes
natively does not. Putting that seam at *ports* rather than at *streams* means
the thing above — streams, calls, RPC — is written once and runs everywhere,
and the emulation exists only where a transport genuinely offers one pipe.

## What it deliberately does not do

A port sends and receives messages. That is all.

No backpressure, no acknowledgements, no credit, no buffering ceiling. This
matches `MessagePort` semantics exactly, and it is what keeps the layer small
enough to reason about. Waiting strategies belong above.

The one safety property it does hold: **a message for a port with no consumer is
dropped, never queued.** Layer 1 never accumulates on behalf of a consumer that
does not exist, so a peer that floods an unaccepted port cannot grow memory here.

## Install

```bash
pnpm add @statewalker/webrun-ports
```

## Getting started

```ts
import { multiplexPort, structuredCodec } from "@statewalker/webrun-ports";

const channel = new MessageChannel();

// The responder accepts inbound ports.
const server = multiplexPort(channel.port2, {
  codec: structuredCodec,
  side: "responder",
  onPort: (port, meta) => {
    if (meta !== "chat") return false; // reject anything else
    port.addEventListener("message", (event) => {
      port.postMessage(`echo: ${String(event.data)}`);
    });
  },
});

// The initiator opens them.
const client = multiplexPort(channel.port1, { codec: structuredCodec });
const chat = client.openPort("chat");

const reply = new Promise<unknown>((resolve) => {
  chat.addEventListener("message", (event) => resolve(event.data));
});
chat.postMessage("hello");
console.log(await reply); // -> "echo: hello"

await client.close();
await server.close();
```

## API

### `multiplexPort(port, options): PortMux`

The default implementation, which emulates multiplexing over a single port. A
transport that already multiplexes natively supplies its own `PortMux` instead.

| option | type | meaning |
| --- | --- | --- |
| `codec` | `PortCodec` | How envelopes reach the wire. Required. |
| `onPort` | `(port, meta?) => boolean \| undefined` | Called when the peer opens a port. Return `false` to reject. **Without it, inbound ports are rejected.** |
| `side` | `"initiator" \| "responder"` | Id parity — initiator allocates even, responder odd, so both ends may open concurrently. Defaults to `"initiator"`. |
| `maxPorts` | `number` | Ceiling on **concurrently** open ports. Defaults to `1024`. Closing a port frees its slot immediately, so a long-lived mux can open unboundedly many over its lifetime — this bounds the id table, never the total. It also never delays a message. |
| `maxMessageSize` | `number` | Largest message this transport can carry, if it has a limit. Reported, not enforced — the layer above chunks to it. |

### `PortMux`

| member | meaning |
| --- | --- |
| `openPort(meta?)` | Allocate a port, announce it, and return the local end immediately. Does not wait for the peer to accept. Throws `RangeError` past `maxPorts`. |
| `close()` | Close every virtual port, then release the underlying port. |
| `maxMessageSize` | See above. |

`openPort` returning before acceptance is deliberate: it keeps layer 1 free of
round trips. Messages posted before the peer accepts are sent, and dropped at the
far end if it rejects; the port becomes inert.

**No close is observable at this layer — not a rejection, and not an orderly close
either.** `MessageTarget` has no close event and the port you hold exposes no
queryable state, so when a port closes its listeners are simply cleared and
`postMessage` becomes a silent no-op. You get no event, no error, and no callback,
and a `close` envelope's `reason` is discarded rather than delivered. A closed port
is indistinguishable from a working one that nobody is answering.

This is deliberate — a real `MessagePort` behaves the same way, and a close event
would make this something other than a port — but it means **the layer above must
carry its own end-of-stream signal** as an ordinary message, sent before the port
closes, rather than relying on the close being seen.

### `structuredCodec`

For ports whose messages are structured values. Envelopes pass through
unencoded, so nothing is serialised and `ArrayBuffer`s move zero-copy through the
transfer list.

A byte transport needs a codec that encodes; that one ships with
`@statewalker/webrun-msgpack`, so this package keeps no dependencies.

### `PortEnvelope`

What crosses the wire: `{ type: "open", id, meta? }`, `{ type: "message", id,
payload }`, `{ type: "close", id, reason? }`.

`reason` is opaque: layer 1 never inspects it — and, as implemented, never surfaces
it either. Setting one accomplishes nothing observable at this layer today; it
exists so the wire format does not have to change when a layer above starts
carrying it.

## Dependencies

**None at runtime.** `@statewalker/webrun-streams` is imported for types only
(`MessageTarget`, `MessageListener`) and is erased at build time.

## Licence

MIT
