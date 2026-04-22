/** Decode Uint8Array chunks to string chunks via TextDecoder, handling split multi-byte characters. */
export async function* decodeText(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of input) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Encode string chunks to Uint8Array chunks via TextEncoder. */
export async function* encodeText(input: AsyncIterable<string>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const str of input) {
    yield encoder.encode(str);
  }
}
