/** Collect all items from an async iterable into an array. */
export async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of input) items.push(item);
  return items;
}

/** Concatenate all Uint8Array chunks into a single Uint8Array. */
export async function collectBytes(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input) {
    chunks.push(chunk);
    total += chunk.length;
  }
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Concatenate all string chunks into a single string. */
export async function collectString(input: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of input) result += chunk;
  return result;
}
