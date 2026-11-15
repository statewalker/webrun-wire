import { newAsyncGenerator } from "./new-async-generator.js";
import type { IteratorChunk } from "./send-iterator.js";

export type ChunkReceiver<T> = (chunk?: IteratorChunk<T>) => Promise<boolean>;
export type ReceiverInstaller<T> = (
  deliver: ChunkReceiver<T>,
) => (() => void | Promise<void>) | undefined | void;

/**
 * Inverse of {@link sendIterator}: turns a sequence of `{done, value, error}`
 * chunks (delivered to the supplied callback by `installer`) into an async
 * generator.
 *
 * The `installer` is given a `deliver` function. It should call `deliver`
 * once for each incoming chunk and may return a cleanup callback that
 * runs when the consumer stops iterating.
 */
export function receiveIterator<T>(installer: ReceiverInstaller<T>): AsyncGenerator<T> {
  return newAsyncGenerator<T>((next, done) => {
    const cleanup = installer(async (chunk = { done: true }) => {
      const { done: isDone = true, value, error } = chunk;
      if (error) return await done(error as Error);
      if (isDone) return await done();
      return await next(value as T);
    });
    if (cleanup) {
      return async () => {
        await cleanup();
      };
    }
    return undefined;
  });
}
