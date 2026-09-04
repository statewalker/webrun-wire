/**
 * Credit payloads are a single big-endian uint32, matching the frame header's
 * byte order.
 *
 * Deliberately **not** re-exported from `index.ts`: this is an internal codec
 * for the `emulateMux` wire format, not a compatibility commitment. Tests
 * import it by path.
 */
/** The largest credit a single frame can advertise or grant: 2^32 - 1. */
export const MAX_UINT32 = 0xffffffff;

/**
 * Clamps rather than wraps. `n >>> 0` is the obvious spelling and it is wrong
 * here: 2^32 becomes **0**, so a 4 GiB window advertises *zero credit* and the
 * peer stalls forever with no error — the exact silent hang credit exists to
 * remove. 2^32 + 5 becomes 5, which looks like a working window and is worse.
 * Anything above the ceiling is advertised as the ceiling.
 */
export function encodeUint32(n: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const clamped = Number.isFinite(n) ? Math.min(MAX_UINT32, Math.max(0, Math.floor(n))) : 0;
  new DataView(bytes.buffer).setUint32(0, clamped, false);
  return bytes;
}

/**
 * Returns `undefined` rather than a garbage number when the payload is too
 * short, so a truncated frame — or one from a peer predating credit — is
 * detectable at the call site instead of silently granting nonsense.
 */
export function decodeUint32(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 4) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}
