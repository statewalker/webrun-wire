/**
 * Bytes to base64 and back, for a transport that carries text only (a
 * `chrome.runtime.Port` serialises its messages as JSON). Uses the runtime's
 * `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64` where it has them
 * (Chromium 140 and later), else `btoa` / `atob` over 32 KiB slices.
 */

interface NativeBase64 {
  toBase64?: (this: Uint8Array) => string;
}
interface NativeFromBase64 {
  fromBase64?: (text: string) => Uint8Array;
}

const nativeTo = (Uint8Array.prototype as NativeBase64).toBase64;
const nativeFrom = (Uint8Array as unknown as NativeFromBase64).fromBase64;

/** Whether this runtime has native base64 on `Uint8Array`. */
export const NATIVE_BASE64 = typeof nativeTo === "function" && typeof nativeFrom === "function";

/** `bytes` as standard base64, with padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (NATIVE_BASE64) return (nativeTo as (this: Uint8Array) => string).call(bytes);
  let text = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  }
  return btoa(text);
}

/** The bytes of standard base64 `text`. Throws on anything else. */
export function base64ToBytes(text: string): Uint8Array {
  if (NATIVE_BASE64) return (nativeFrom as (text: string) => Uint8Array)(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
