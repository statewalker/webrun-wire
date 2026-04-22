/** Apply a sync or async function to each item in a stream. */
export async function* map<I, O>(
  input: AsyncIterable<I>,
  fn: (item: I) => O | Promise<O>,
): AsyncGenerator<O> {
  for await (const item of input) {
    yield await fn(item);
  }
}
