/**
 * Synthetic short id for a libp2p peer id. The peer id strings
 * (`12D3KooW...`) are long and visually indistinguishable at a glance.
 * For demo UX we derive a deterministic 8-hex-char id from the first
 * 4 bytes of `SHA-1(peerId)`. Same peer → same synth, every time, in
 * every tab.
 *
 * The hash is computed asynchronously via WebCrypto and cached in a
 * module-scoped Map. Renderers call `ensureSynth(peerId)` to start the
 * computation (fire-and-forget) and `synthOf(peerId)` synchronously to
 * read the current value (returns a placeholder until the hash lands).
 * Subscribe to `onSynthCacheUpdate(cb)` to re-render whenever a new
 * synth lands in the cache.
 */

const synthCache = new Map<string, string>();
const cbs = new Set<() => void>();

const PENDING = "······";

export function synthOf(peerId: string): string {
  return synthCache.get(peerId) ?? PENDING;
}

export async function ensureSynth(peerId: string): Promise<string> {
  const cached = synthCache.get(peerId);
  if (cached) return cached;
  const data = new TextEncoder().encode(peerId);
  const hash = await crypto.subtle.digest("SHA-1", data);
  const bytes = new Uint8Array(hash, 0, 4);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  // Format as two 4-char groups separated by a dash for readability:
  // "a3f9-c2d1". Visually scannable in a list of N peers.
  const formatted = `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
  synthCache.set(peerId, formatted);
  for (const cb of cbs) {
    try {
      cb();
    } catch (err) {
      console.error("[peer-id-synth] subscriber threw:", err);
    }
  }
  return formatted;
}

export function onSynthCacheUpdate(cb: () => void): () => void {
  cbs.add(cb);
  return () => {
    cbs.delete(cb);
  };
}
