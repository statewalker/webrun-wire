/**
 * Credit-based flow control, as a pair of pure state machines with no I/O.
 *
 * The sender holds a {@link CreditLedger}: it reserves credit before it puts
 * anything on the wire, and stalls at zero. The receiver holds a
 * {@link CreditGrantor}: it counts what its consumer has actually drained and
 * says when to hand the sender more.
 *
 * A sender therefore cannot overrun a receiver's buffer, because it was never
 * granted permission to. That is the property a sender-side window cannot
 * offer: the receiver's capacity is not knowable to the sender unless the
 * receiver states it.
 *
 * **The unit is opaque.** This module never interprets the numbers it counts.
 * `emulateMux` passes byte counts and advertises `maxStreamBuffer`; the RPC
 * tier passes 1 per value and advertises a maximum in-flight value count.
 * Nothing here depends on which.
 */

export interface CreditLedger {
  /** Units authorised by the peer and not yet reserved. */
  readonly available: number;
  /**
   * Reserve up to `upTo` units, resolving with how many were actually
   * granted — at least 1, never more than `upTo`. The caller sends exactly
   * that much and calls `reserve` again for the rest.
   *
   * `upTo` must itself be at least 1; anything less rejects with a
   * `RangeError` rather than resolving with 0, which would be a silent no-op
   * that also consumed a waiter slot.
   *
   * Returning a partial amount rather than waiting for the full request is
   * what makes the ledger deadlock-free: a peer that advertises less than
   * one `upTo` still makes progress, one short piece at a time.
   *
   * Rejects if {@link fail} is called.
   */
  reserve(upTo: number): Promise<number>;
  /** The peer authorised `units` more. */
  grant(units: number): void;
  /** Reject every pending and future reservation — transport or stream is gone. */
  fail(err: Error): void;
}

interface Waiter {
  upTo: number;
  resolve: (granted: number) => void;
  reject: (err: Error) => void;
}

export function newCreditLedger(initial = 0): CreditLedger {
  let available = initial;
  let failure: Error | undefined;
  const waiters: Waiter[] = [];

  // Waiters are released strictly in order, head first. Letting a later
  // reservation overtake an earlier one would reorder the stream.
  const pump = (): void => {
    while (waiters.length > 0 && available > 0) {
      const next = waiters[0];
      if (!next) return;
      waiters.shift();
      const granted = Math.min(next.upTo, available);
      available -= granted;
      next.resolve(granted);
    }
  };

  return {
    get available() {
      return available;
    },
    reserve(upTo: number): Promise<number> {
      if (failure) return Promise.reject(failure);
      // A reservation below one unit is a caller bug, not a legal request: the
      // contract is "at least 1", and the queued path would otherwise consume
      // a waiter in order to hand back nothing.
      if (!(upTo >= 1)) {
        return Promise.reject(
          new RangeError(`newCreditLedger: reserve(${upTo}) — upTo must be at least 1`),
        );
      }
      if (waiters.length === 0 && available > 0) {
        const granted = Math.min(upTo, available);
        available -= granted;
        return Promise.resolve(granted);
      }
      return new Promise<number>((resolve, reject) => {
        waiters.push({ upTo, resolve, reject });
      });
    },
    grant(units: number): void {
      if (failure) return;
      available += units;
      pump();
    },
    fail(err: Error): void {
      failure ??= err;
      while (waiters.length > 0) {
        waiters.shift()?.reject(err);
      }
    },
  };
}

export interface CreditGrantor {
  /**
   * Record that the consumer drained `units`, and whether the receive queue
   * is now empty. Returns the credit to hand back to the peer, or `0` to stay
   * silent and keep accumulating.
   */
  consumed(units: number, queueEmpty: boolean): number;
}

/**
 * Grants are batched: replenishing on every chunk while the receiver is
 * behind would reinvent the per-frame ACK this change exists to remove.
 * `threshold` is the fraction of the window that must drain before a grant is
 * emitted.
 *
 * The batch is flushed unconditionally once the receive queue is empty, even
 * below the threshold, so the receiver never sits on credit it owes. Note what
 * this is and is not: paired with a {@link CreditLedger}, a sender blocks only
 * at *exactly* zero credit, and at that point the receiver holds the entire
 * window as `pending` — above any threshold at or below the whole window — so
 * the threshold alone cannot deadlock that pairing. The flush is what keeps
 * that from being an argument about a global accounting identity: it is
 * locally decidable from one boolean, and it returns owed credit now rather
 * than at the next threshold crossing. It costs an extra frame only when the
 * consumer is keeping pace, which is exactly when the sender is not blocked
 * and the frame is cheap.
 */
export function newCreditGrantor(window: number, threshold = 0.5): CreditGrantor {
  const trigger = Math.max(1, Math.floor(window * threshold));
  let pending = 0;
  return {
    consumed(units: number, queueEmpty: boolean): number {
      pending += units;
      if (pending === 0) return 0;
      if (pending < trigger && !queueEmpty) return 0;
      const grant = pending;
      pending = 0;
      return grant;
    },
  };
}
