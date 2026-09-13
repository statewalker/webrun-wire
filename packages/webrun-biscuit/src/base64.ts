/** URL-safe base64 without padding, the wire form of a Biscuit token.
 *  Implemented directly so the library stays runtime-agnostic (no Buffer,
 *  no atob/btoa). */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REVERSE = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));
REVERSE.set("+", 62);
REVERSE.set("/", 63);

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const s = text.trim().replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = REVERSE.get(c);
    if (v === undefined) throw new Error(`invalid base64 character ${JSON.stringify(c)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
