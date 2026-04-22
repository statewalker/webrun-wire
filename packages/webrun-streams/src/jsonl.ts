import { splitLines } from "./lines.js";
import { map } from "./map.js";

/** Encode each value as a JSON line (terminated by \n). */
export async function* encodeJsonl<T>(input: AsyncIterable<T>): AsyncGenerator<string> {
  yield* map(input, (item) => `${JSON.stringify(item)}\n`);
}

/** Decode each line as a JSON value. Skips empty lines. */
export async function* decodeJsonl<T>(input: AsyncIterable<string>): AsyncGenerator<T> {
  for await (const line of splitLines(input)) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as T;
  }
}
