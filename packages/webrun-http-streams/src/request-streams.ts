/**
 * The one place that knows a runtime may not implement request body streams,
 * and the buffering both fallbacks need. `fetch.ts` and `http-stubs.ts` each
 * carry a client and a server direction that must agree on the answer, so the
 * predicate lives here rather than being written out four times.
 */

/**
 * Whether `Request.prototype` exposes a `body` accessor. Two call sites read
 * that property, and two more depend on the constructor accepting a
 * `ReadableStream` as `init.body`; this predicate answers for all four.
 *
 * What was verified, and all that is claimed here: Firefox (146 at the time of
 * writing) has *neither*, and Chromium and Node have *both*. On Firefox it is
 * not that `body` is `undefined` on the instance —
 * `Object.getOwnPropertyDescriptor(Request.prototype, "body")` is `null`, the
 * accessor is genuinely absent — and because a `ReadableStream` is then not a
 * recognised `BodyInit`, the constructor falls through to the string branch and
 * stores the literal text `[object ReadableStream]`.
 *
 * The two halves are NOT guaranteed to ship together, so do not read this as a
 * test for "request streams" in general. Safari is the counterexample: it has
 * had `Request.body` since 11.1 but only accepts a stream as `init.body` from
 * Technology Preview 250, so a shipping Safari has the reader half without the
 * upload half and this returns `true` there. That looks benign — WebKit appears
 * to store the stream on the `Request` rather than stringify it, and its error
 * comes from `fetch()`, which this package never calls on the objects it builds
 * — but it is untested, and it is the case to look at first if a Safari report
 * arrives. The sharper probe, if one is ever needed, is whether
 * `new Request(url, {method:"POST", body:new ReadableStream(), duplex:"half"})`
 * has a `content-type` of `text/plain;charset=UTF-8` (stringified) or `null`
 * (stored); it is not used here because it costs a `Request` and a
 * `ReadableStream` per call and agrees with the descriptor check on every
 * runtime measured.
 *
 * A capability check, never a user-agent test: the question is what this
 * runtime does, and the answer flips on its own the day Firefox ships request
 * streams. Evaluated per call rather than cached at module load so that a test
 * can install a `Request` without the capability and exercise the real branch
 * under Node.
 */
export function supportsRequestStreams(): boolean {
  return (
    typeof Request === "function" &&
    Object.getOwnPropertyDescriptor(Request.prototype, "body") != null
  );
}

/**
 * Drain a body iterable into one contiguous buffer. Only the fallbacks need it.
 * Allocates its own buffer rather than reusing `bytes.ts`'s `concatChunks`,
 * which passes a single chunk straight through: that chunk is a view onto the
 * decoder's own read buffer, and the result here is handed to `new Request` and
 * outlives the decode. The allocation is also what makes it a
 * `Uint8Array<ArrayBuffer>`, which `BodyInit` accepts and the looser
 * `Uint8Array<ArrayBufferLike>` does not.
 */
export async function collectBytes(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    if (chunk.byteLength === 0) continue;
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
