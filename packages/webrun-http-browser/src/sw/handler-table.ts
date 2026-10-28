/**
 * The ServiceWorker's table of handler links, per key. Pure bookkeeping, no
 * ports, so routing can be tested without a browser.
 */

/** What a `route` function sees of a handler. */
export interface HandlerInfo {
  /** The handler slot, unique within its key. */
  readonly id: string;
  readonly key: string;
  /** Token of the current attachment; `drain` and `detach` must name it. */
  readonly owner: string;
  /** Requests sent to it whose responses have not finished. */
  readonly inflight: number;
  /** Whatever the attaching page sent. */
  readonly meta: unknown;
  /** When it attached (`Date.now()`); ties go to the oldest. */
  readonly attachedAt: number;
  /** Draining: it finishes what it has and gets nothing new. */
  readonly draining: boolean;
}

/**
 * Picks the handler for one request among the live (not draining) handlers of
 * its key. `undefined` means none of them: the request waits for another, as
 * when there is none at all.
 */
export type RouteFunction = <H extends HandlerInfo>(
  request: Request,
  key: string,
  handlers: H[],
) => H | undefined;

/**
 * The default route: the handler with the fewest requests in flight, the
 * oldest on a tie. With one handler per key — one tab — that is the first
 * live handler of the key, as before routing was pluggable.
 */
export const leastInflightRoute: RouteFunction = (_request, _key, handlers) => {
  let best: (typeof handlers)[number] | undefined;
  for (const handler of handlers) {
    if (
      best === undefined ||
      handler.inflight < best.inflight ||
      (handler.inflight === best.inflight && handler.attachedAt < best.attachedAt)
    ) {
      best = handler;
    }
  }
  return best;
};

export class HandlerTable<E extends HandlerInfo> {
  private readonly _entries = new Map<string, Map<string, E>>();
  private _waiters: Array<{ key: string; resolve: (found: boolean) => void }> = [];

  /** Adds `entry`. Returns the entry it replaces (same key and id), if any. */
  add(entry: E): E | undefined {
    let slots = this._entries.get(entry.key);
    if (!slots) {
      slots = new Map();
      this._entries.set(entry.key, slots);
    }
    const replaced = slots.get(entry.id);
    slots.set(entry.id, entry);
    if (!entry.draining) {
      this._waiters = this._waiters.filter(({ key, resolve }) => {
        if (key !== entry.key) return true;
        resolve(true);
        return false;
      });
    }
    return replaced;
  }

  /** Removes `entry` if it is still the one in its slot. */
  remove(entry: E): boolean {
    const slots = this._entries.get(entry.key);
    if (slots?.get(entry.id) !== entry) return false;
    slots.delete(entry.id);
    if (slots.size === 0) this._entries.delete(entry.key);
    return true;
  }

  get(key: string, id: string): E | undefined {
    return this._entries.get(key)?.get(id);
  }

  /** Every entry of `key`, draining or not. */
  all(key: string): E[] {
    return [...(this._entries.get(key)?.values() ?? [])];
  }

  /** The entries of `key` that take new requests. */
  live(key: string): E[] {
    return this.all(key).filter((entry) => !entry.draining);
  }

  entries(): E[] {
    return [...this._entries.values()].flatMap((slots) => [...slots.values()]);
  }

  get size(): number {
    let size = 0;
    for (const slots of this._entries.values()) size += slots.size;
    return size;
  }

  /**
   * Resolves `true` once a live entry for `key` is added (at once if there is
   * one, unless `next`), `false` after `ms`.
   */
  waitFor(key: string, ms: number, next = false): Promise<boolean> {
    if (!next && this.live(key).length > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        key,
        resolve: (found: boolean) => {
          clearTimeout(timer);
          resolve(found);
        },
      };
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        resolve(false);
      }, ms);
      this._waiters.push(waiter);
    });
  }
}
