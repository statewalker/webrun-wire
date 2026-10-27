/**
 * Matches replies to requests by id, for the control messages that hand
 * WebSocket ports across: each waiting request has a deadline, and all of a
 * peer's waiting requests can be failed at once when the peer is lost.
 */
export class PortRendezvous<T> {
  private readonly _waiting = new Map<
    string,
    {
      resolve: (value: T) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _counter = 0;

  constructor(private readonly _prefix = "r") {}

  /** A fresh id for a request. */
  newId(): string {
    return `${this._prefix}:${++this._counter}`;
  }

  get size(): number {
    return this._waiting.size;
  }

  /** Waits for the reply to `id`, failing after `timeoutMs`. */
  wait(id: string, timeoutMs: number, describe = "the reply"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiting.delete(id);
        reject(new Error(`No answer to ${describe} within ${timeoutMs} ms`));
      }, timeoutMs);
      this._waiting.set(id, { resolve, reject, timer });
    });
  }

  /** Delivers the reply to `id`. `false` when nobody waits for it (it timed out). */
  settle(id: string, value: T): boolean {
    const waiting = this._waiting.get(id);
    if (!waiting) return false;
    this._waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(value);
    return true;
  }

  fail(id: string, error: Error): void {
    const waiting = this._waiting.get(id);
    if (!waiting) return;
    this._waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }

  failAll(error: Error): void {
    for (const id of [...this._waiting.keys()]) this.fail(id, error);
  }
}
