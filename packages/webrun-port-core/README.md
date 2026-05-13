# @statewalker/webrun-port-core

Toolkit for building **bridged `MessagePort` adapters** — adapters that take a remote transport (WebSocket, WebRTC DataChannel, libp2p Stream, LiveKit Room, PeerJS DataConnection, …) and yield a real WHATWG `MessagePort` whose peer half lives at the far end of that transport.

Every adapter in the `webrun-port-*` family is built on `bindBytesToPort` from this package. The toolkit is intentionally minimal: one primitive function plus one byte-normalisation helper plus the framing protocol.

## Contract

A bridged `MessagePort` is a real `MessagePort`. It satisfies the WHATWG interface. **But it does not deliver everything a same-thread `MessageChannel` delivers.** The following constraints apply to every adapter built on this toolkit:

- **Byte payloads.** Adapters guarantee correct round-trip for `Uint8Array` payloads of arbitrary size. Adapters transparently chunk messages above the transport MTU.
- **JSON-shaped envelope payloads.** Adapters round-trip JSON-shaped structured objects — specifically the `callBidi` envelope shape `{ channelName, callId, type, ... }`. Internally these are serialised as JSON. Values that JSON cannot represent (Date, Map, Set, BigInt, functions, cyclic graphs) are not supported.
- **No transferables.** `port.postMessage(data, [transferable])` is not honoured across a bridge. The `transfer` argument is ignored. A real `MessagePort` *can* be transferred across a same-thread `MessageChannel`, but not across a WebRTC / libp2p / WebSocket / LiveKit bridge.
- **Ordered, reliable.** Messages arrive in send order, exactly once. Adapters do not expose unordered or unreliable modes in v1.
- **Close propagates.** Calling `port.close()` on either side surfaces close on the peer within a bounded delay defined by the underlying transport.

## API

### `bindBytesToPort(transport)`

```ts
import { bindBytesToPort } from "@statewalker/webrun-port-core";

const port: MessagePort = bindBytesToPort({
  postChunk(bytes: Uint8Array) {
    // Send these bytes over the transport.
  },
  onChunk(handler: (bytes: Uint8Array) => void): () => void {
    // Register a listener for inbound transport bytes.
    // Return an unsubscribe function.
  },
  onClose(handler: () => void): () => void {
    // Register a listener for transport close.
    // Return an unsubscribe function.
  },
  close() {
    // Close the underlying transport.
  },
  mtu: 65536, // Maximum bytes per postChunk call.
});
```

Returns a real `MessagePort`. The toolkit allocates a `MessageChannel` internally, wires `port2` to the transport, and returns `port1` to the caller.

### `normalizeToUint8Array(data)`

Accepts `Uint8Array`, `ArrayBuffer`, `ArrayBufferView`, `Blob`, or `string`. Returns `Uint8Array` (or `Promise<Uint8Array>` for `Blob`). Throws `TypeError` for any other input.

## Framing protocol

Each `postMessage` payload is wrapped with a 1-byte envelope tag (raw bytes vs. structured object) and then framed:

- Messages whose framed payload fits in `mtu - 1` bytes are sent as one transport frame `[0x00 LAST][payload]`.
- Larger messages are sent as a sequence `[0x01 CONT][payload]…[0x00 LAST][payload]`. The receiver concatenates `CONT` payloads with the next `LAST` payload.

Single-writer ordering at the adapter — message N completes before any chunk of message N+1. Multiplexing of concurrent logical streams lives at the `callBidi` / `listenBidi` layer above the port.

## Close convention

Closing the returned port calls the transport's `close`. The transport's close handler fires the port's internal close, surfacing it to any listener on the caller side and on the peer.

## What this toolkit does **not** do

- It does not establish the underlying transport. The adapter does that.
- It does not handle signalling, authentication, or reconnection. The adapter does that.
- It does not introduce a `MessagePortLike` interface. See [ADR-0002](../../docs/adr/0002-message-port-as-seam.md).

## License

MIT
