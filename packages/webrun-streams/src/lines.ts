/** Split a stream of string chunks into individual lines (delimited by \n). */
export async function* splitLines(input: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer) yield buffer;
}

/** Append \n to each string in the stream. */
export async function* joinLines(input: AsyncIterable<string>): AsyncGenerator<string> {
  for await (const line of input) {
    yield `${line}\n`;
  }
}
