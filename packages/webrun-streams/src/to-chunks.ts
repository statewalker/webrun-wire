const DEFAULT_CHUNK_SIZE = 16 * 1024;

/**
 * Curried `Duplex`-shaped transformer that splits incoming `Uint8Array`s into
 * chunks no larger than `size` bytes. Empty input chunks are skipped; small
 * input chunks pass through unchanged (zero-copy `subarray` views are used
 * when splitting, so no allocation per chunk).
 *
 * Use to respect transport MTUs before reaching `channel.send`. Reassembly on
 * the receive side is not needed — consumers iterate a continuous byte stream.
 */
export function toChunks(
  size: number = DEFAULT_CHUNK_SIZE,
): (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => AsyncGenerator<Uint8Array> {
  if (!(Number.isInteger(size) && size > 0)) {
    throw new RangeError(`toChunks: size must be a positive integer, got ${size}`);
  }
  return async function* (input) {
    for await (const block of input) {
      if (block.byteLength === 0) continue;
      if (block.byteLength <= size) {
        yield block;
        continue;
      }
      let offset = 0;
      while (offset < block.byteLength) {
        const end = Math.min(offset + size, block.byteLength);
        yield block.subarray(offset, end);
        offset = end;
      }
    }
  };
}
