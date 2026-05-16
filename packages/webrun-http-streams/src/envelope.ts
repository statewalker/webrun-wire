export type RequestEnvelope = {
  url: string;
  method: string;
  headers: [string, string][];
};

export type ResponseEnvelope = {
  status: number;
  statusText: string;
  headers: [string, string][];
};

const NEWLINE = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode an HTTP envelope plus optional body as one continuous byte stream:
 *
 *     <JSON.stringify(envelope)>\n<body bytes...>
 *
 * `JSON.stringify` with default whitespace never emits a literal `\n`, so the
 * first `0x0a` byte unambiguously terminates the envelope.
 *
 * This is the same wire shape used by the legacy `webrun-http-port` package.
 */
export async function* encodeMessage<E>(
  envelope: E,
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield encoder.encode(`${JSON.stringify(envelope)}\n`);
  if (!body) return;
  for await (const chunk of body) {
    if (chunk.byteLength > 0) yield chunk;
  }
}

/**
 * Consume an envelope-then-body byte stream. Returns the parsed envelope and
 * an async iterable over the remaining body bytes.
 */
export async function decodeMessage<E>(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<{ envelope: E; body: AsyncIterable<Uint8Array> }> {
  const iter = toAsyncIterator(input);
  const accum: Uint8Array[] = [];
  let accumLen = 0;
  let before: Uint8Array;
  let tail: Uint8Array;

  while (true) {
    const next = await iter.next();
    if (next.done) {
      throw new Error(
        `decodeMessage: stream ended after ${accumLen} bytes without delimiter (\\n)`,
      );
    }
    const chunk = next.value;
    if (chunk.byteLength === 0) continue;
    const nl = chunk.indexOf(NEWLINE);
    if (nl === -1) {
      accum.push(chunk);
      accumLen += chunk.byteLength;
      continue;
    }
    accum.push(chunk.subarray(0, nl));
    accumLen += nl;
    before = concatChunks(accum, accumLen);
    tail = chunk.subarray(nl + 1);
    break;
  }

  let envelope: E;
  try {
    envelope = JSON.parse(decoder.decode(before)) as E;
  } catch (err) {
    throw new Error(
      `decodeMessage: malformed envelope JSON at bytes 0..${before.byteLength}: ${(err as Error).message}`,
    );
  }

  async function* body(): AsyncGenerator<Uint8Array> {
    if (tail.byteLength > 0) yield tail;
    while (true) {
      const next = await iter.next();
      if (next.done) return;
      if (next.value.byteLength > 0) yield next.value;
    }
  }

  return { envelope, body: body() };
}

function toAsyncIterator(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterator<Uint8Array> {
  const asyncIter = (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator];
  if (asyncIter) return asyncIter.call(input as AsyncIterable<Uint8Array>);
  const syncIter = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    next(): Promise<IteratorResult<Uint8Array>> {
      return Promise.resolve(syncIter.next());
    },
  };
}

function concatChunks(parts: Uint8Array[], totalLen: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
