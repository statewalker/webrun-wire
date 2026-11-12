import type { SerializedError } from "@statewalker/webrun-streams";

const encoder = new TextEncoder();
/** Fields kept to the last: what identifies the error. */
const KEEP = new Set(["message", "name", "code", "status", "truncated"]);
const MARK = " … [truncated]";

/**
 * An upper estimate of `value`'s encoded size in bytes, for msgpack or a
 * structured clone: strings by UTF-8 length, binary by its length, plus a few
 * bytes of header per value. Deliberately generous, so what it passes fits.
 */
export function encodedSizeEstimate(value: unknown, depth = 0): number {
  if (depth > 32) return 0;
  if (value == null || typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 9;
  if (typeof value === "string") return encoder.encode(value).byteLength + 5;
  if (ArrayBuffer.isView(value)) return value.byteLength + 5;
  if (value instanceof ArrayBuffer) return value.byteLength + 5;
  if (Array.isArray(value)) {
    let n = 5;
    for (const item of value) n += encodedSizeEstimate(item, depth + 1);
    return n;
  }
  if (typeof value === "object") {
    let n = 5;
    for (const [k, v] of Object.entries(value)) {
      n += encodedSizeEstimate(k, depth + 1) + encodedSizeEstimate(v, depth + 1);
    }
    return n;
  }
  return encodedSizeEstimate(String(value), depth + 1);
}

/**
 * `error`, made to fit `maxBytes`, so it crosses a transport with a message
 * ceiling as one message. An error is sent whole — it is not a body to chunk —
 * and a stack or an attached field (an HTTP body) can be any size: past the
 * transport's ceiling it is dropped or kills the connection. In order, until
 * it fits: the stack goes, then the largest extra fields, then the message is
 * cut, keeping its start. A changed result carries `truncated: true`.
 */
export function fitSerializedError(error: SerializedError, maxBytes: number): SerializedError {
  if (encodedSizeEstimate(error) <= maxBytes) return error;
  const out: SerializedError = { ...error, truncated: true };
  delete out.stack;
  const extras = Object.keys(out)
    .filter((k) => !KEEP.has(k))
    .sort((a, b) => encodedSizeEstimate(out[b]) - encodedSizeEstimate(out[a]));
  for (const key of extras) {
    if (encodedSizeEstimate(out) <= maxBytes) return out;
    delete out[key];
  }
  if (encodedSizeEstimate(out) <= maxBytes) return out;
  // Cut the message to what is left, by characters, then trim until it fits.
  const rest = encodedSizeEstimate({ ...out, message: "" }) + MARK.length * 3;
  let keep = Math.max(0, maxBytes - rest);
  let message = String(out.message);
  if (message.length > keep) message = message.slice(0, keep);
  while (keep > 0 && encodedSizeEstimate({ ...out, message: message + MARK }) > maxBytes) {
    keep = Math.floor(keep * 0.9);
    message = message.slice(0, keep);
  }
  out.message = message + MARK;
  return out;
}
