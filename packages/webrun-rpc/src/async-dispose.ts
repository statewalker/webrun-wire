/**
 * Makes `target` disposable with `await using`: installs `dispose` as its
 * `[Symbol.asyncDispose]`, where the runtime defines the symbol. Hand-written
 * iterators lose what a native generator gets from `AsyncIteratorPrototype`;
 * this gives it back. A no-op where the symbol is missing. Kept off the
 * declared types, which would require consumers to compile with the
 * `esnext.disposable` lib.
 */
export function asyncDisposable<T extends object>(target: T, dispose: () => Promise<unknown>): T {
  // Read here, not at module level: a top-level read is code a bundler keeps.
  const asyncDispose = (Symbol as { asyncDispose?: symbol }).asyncDispose;
  if (asyncDispose && !(asyncDispose in target)) {
    Object.defineProperty(target, asyncDispose, {
      value: async () => {
        await dispose();
      },
      configurable: true,
      writable: true,
    });
  }
  return target;
}
