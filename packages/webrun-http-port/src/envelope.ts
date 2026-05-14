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
 * Encode an envelope plus optional body as a single continuous byte stream:
 *
 *     <JSON.stringify(envelope)>\n<body bytes...>
 *
 * `JSON.stringify` with default whitespace emits no literal newlines, so the
 * first `0x0a` byte unambiguously terminates the envelope.
 */
export async function* encodeMessage<E>(
  envelope: E,
  body?: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield encoder.encode(`${JSON.stringify(envelope)}\n`);
  if (!body) return;
  for await (const chunk of body) {
    if (chunk.byteLength > 0) yield chunk;
  }
}

/**
 * Consume an envelope-then-body byte stream. Reads bytes until the first
 * `0x0a`, parses the prefix as JSON to recover the envelope, and surfaces the
 * remainder (the tail of the current chunk plus all subsequent chunks) as the
 * body `AsyncIterable<Uint8Array>`.
 *
 * Rejects if the underlying iterable ends before the newline delimiter, or if
 * the prefix is not valid JSON.
 */
export async function decodeMessage<E>(
  input: AsyncIterable<Uint8Array>,
): Promise<{ envelope: E; body: AsyncIterable<Uint8Array> }> {
  const iter = input[Symbol.asyncIterator]();
  const accum: Uint8Array[] = [];
  let accumLen = 0;
  let split: { before: Uint8Array; after: Uint8Array } | null = null;

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
    const before = chunk.subarray(0, nl);
    const after = chunk.subarray(nl + 1);
    accum.push(before);
    accumLen += before.byteLength;
    split = { before: concatChunks(accum, accumLen), after };
    break;
  }

  let envelope: E;
  try {
    envelope = JSON.parse(decoder.decode(split.before)) as E;
  } catch (err) {
    throw new Error(
      `decodeMessage: malformed envelope JSON at bytes 0..${split.before.byteLength}: ${(err as Error).message}`,
    );
  }

  const tail = split.after;
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
