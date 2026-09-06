import type { PortCodec, PortEnvelope } from "@statewalker/webrun-rpc";
import msgpack from "@ygoe/msgpack";

const { serialize, deserialize } = msgpack;

/**
 * Same shape check as `structuredCodec`'s, applied after decoding. A shared
 * transport carries traffic that is not ours, and layer 1 must not mistake it
 * for an envelope.
 */
function isEnvelope(value: unknown): value is PortEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  if (typeof candidate.id !== "number") return false;
  if (!Number.isInteger(candidate.id) || candidate.id < 0) return false;
  return candidate.type === "open" || candidate.type === "message" || candidate.type === "close";
}

/** Accept whatever byte shape a transport pump hands over. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return undefined;
}

/**
 * For ports whose messages are bytes — a WebSocket, a WebRTC data channel, a
 * LiveKit data packet.
 *
 * One envelope becomes one msgpack frame and one `postMessage`. There is no
 * length prefix, because every transport this codec targets preserves message
 * boundaries; adding one would be redundant framing on a transport that
 * already frames. (`encodeMsgpack`/`decodeMsgpack` in this package *do* carry
 * a length prefix — they are a stream codec for a transport with no
 * boundaries, and are a different thing.)
 *
 * The transfer list is deliberately ignored: after encoding, the payload is
 * inside the bytes, so there is nothing left to hand over.
 *
 * **Not interchangeable with `structuredCodec` in one respect:** msgpack drops
 * object keys whose value is `undefined`, where structured clone preserves
 * them. Nothing layer 2 sends depends on that distinction today, and it must
 * not come to — see spec D16.
 */
export const msgpackCodec: PortCodec = {
  post(port, envelope) {
    port.postMessage(serialize(envelope));
  },

  read(event) {
    const bytes = toBytes(event.data);
    if (!bytes || bytes.byteLength === 0) return undefined;
    let decoded: unknown;
    try {
      decoded = deserialize(bytes);
    } catch {
      // A malformed frame is a peer bug or hostile traffic. Dropping it keeps
      // layer 1's drop-never-queue posture; throwing here would escape into
      // the raw port's own listener, outside any consumer's reach.
      return undefined;
    }
    return isEnvelope(decoded) ? decoded : undefined;
  },
};
