import type { PortCodec, PortEnvelope } from "./port-types.js";

function isEnvelope(value: unknown): value is PortEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  if (typeof candidate.id !== "number") return false;
  if (!Number.isInteger(candidate.id) || candidate.id < 0) return false;
  return candidate.type === "open" || candidate.type === "message" || candidate.type === "close";
}

/**
 * For ports whose messages are structured values — a real `MessagePort`, a
 * worker, an iframe.
 *
 * Envelopes are posted as-is, so nothing is encoded, `ArrayBuffer`s move
 * zero-copy through the transfer list, and structured clone does the work the
 * platform already does well. This is a performance choice only: layer 2 may
 * not send anything a byte codec could not also carry.
 */
export const structuredCodec: PortCodec = {
  post(port, envelope, transfer) {
    // An empty transfer list is not the same as no transfer list — some
    // implementations reject the former.
    if (transfer && transfer.length > 0) port.postMessage(envelope, transfer);
    else port.postMessage(envelope);
  },
  read(event) {
    return isEnvelope(event.data) ? event.data : undefined;
  },
};
