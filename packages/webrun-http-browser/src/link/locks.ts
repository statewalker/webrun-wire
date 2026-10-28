/**
 * Liveness through Web Locks.
 *
 * A `MessagePort` never reports that the other side died, but a Web Lock
 * does: a lock held by a page, a worker or a ServiceWorker is released by the
 * browser the moment that context goes away, and a request waiting for it is
 * granted then. So each side that must notice the other's death holds a lock
 * of its own and watches the other's:
 *
 * - a handler holds an owner lock; the ServiceWorker watches it, and fails the
 *   handler's requests in flight when it is granted (the tab closed, the
 *   worker was terminated);
 * - the ServiceWorker holds a router lock; handlers watch it, and fail their
 *   calls through it when it is granted (the browser stopped the worker).
 *
 * Every function here degrades to a no-op where `navigator.locks` is missing.
 */

interface LockManagerLike {
  query?(): Promise<{ held?: Array<{ name?: string }> }>;
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: "exclusive" | "shared" },
    callback: () => unknown,
  ): Promise<unknown>;
}

function lockManager(): LockManagerLike | undefined {
  return (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
}

export function locksAvailable(): boolean {
  return lockManager() !== undefined;
}

/** A fresh lock name: `<prefix>:<uuid>`. */
export function newLockName(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/**
 * Takes the lock `name` and holds it until the returned release is called or
 * this context dies. Resolves once the lock is held; with no Web Locks,
 * resolves at once.
 */
export async function holdLock(name: string): Promise<() => void> {
  const locks = lockManager();
  if (!locks) return () => {};
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((held) => {
    void locks
      .request(name, {}, () => {
        held();
        return released;
      })
      .catch(() => held());
  });
  return release;
}

/**
 * Calls `onLost` once the lock `name` is granted to this context — that is,
 * once whoever holds it is gone — and releases it at once. Returns a function
 * that stops watching. With no Web Locks, never calls `onLost`.
 */
export function watchLock(name: string, onLost: () => void): () => void {
  const locks = lockManager();
  if (!locks) return () => {};
  const controller = new AbortController();
  void locks
    .request(name, { signal: controller.signal }, () => {
      if (!controller.signal.aborted) onLost();
    })
    .catch(() => {
      // Aborted by the returned function: not a loss.
    });
  return () => controller.abort();
}

/**
 * The names of the locks held right now in this origin, or `undefined` where
 * that cannot be asked. A backup for `watchLock`: a grant can be late, a query
 * cannot.
 */
export async function heldLockNames(): Promise<Set<string> | undefined> {
  const locks = lockManager();
  if (!locks?.query) return undefined;
  try {
    const { held = [] } = await locks.query();
    return new Set(held.map((lock) => lock.name ?? ""));
  } catch {
    return undefined;
  }
}
