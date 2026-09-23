/**
 * Settles like `promise` if it settles before `deadline` (a `Date.now()`
 * value). Otherwise calls `onTimeout`: an `Error` it returns rejects, any
 * other value resolves. Internal; not re-exported.
 */
export function withDeadline<T, F>(
  deadline: number,
  promise: Promise<T>,
  onTimeout: () => F,
): Promise<T | (F extends Error ? never : F)> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        const outcome = onTimeout();
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome as F extends Error ? never : F);
      },
      Math.max(0, deadline - Date.now()),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
