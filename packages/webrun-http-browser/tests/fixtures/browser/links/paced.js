// A consumer that reads a stream at a fixed pace, used in the page and in
// workers. Checks every byte against the `big` route's pattern.

/** The byte at `offset` of a `big` body: a pattern no buffer mix-up keeps. */
export const patternByte = (offset) => (offset * 7 + (offset >>> 16)) % 251;

/**
 * Reads `stream` at `rate` bytes per second, calling `onSample(read)` every
 * `sampleMs`. Resolves `{ read, corrupt, ms }`.
 */
export async function readPaced(stream, { rate, sampleMs = 500, onSample = () => {} }) {
  const reader = stream.getReader();
  const started = performance.now();
  let read = 0;
  let corrupt = 0;
  let nextSample = started + sampleMs;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.byteLength; i++) {
      if (value[i] !== patternByte(read + i)) corrupt++;
    }
    read += value.byteLength;
    const now = performance.now();
    if (now >= nextSample) {
      onSample(read);
      nextSample = now + sampleMs;
    }
    // Hold the pace: never ahead of `rate`.
    const due = started + (read / rate) * 1000;
    if (due > now) await new Promise((r) => setTimeout(r, due - now));
  }
  return { read, corrupt, ms: Math.round(performance.now() - started) };
}
