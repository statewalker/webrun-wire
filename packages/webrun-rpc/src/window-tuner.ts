/**
 * The window a port grants its peer (`PortMuxOptions.window`): a fixed number
 * of bytes, or a window that adapts between `initial` and `max`, or `"auto"`
 * ({@link DEFAULT_AUTO_WINDOW}).
 */
export type PortWindow = number | AdaptiveWindow | "auto";

/** An adaptive window (`PortMuxOptions.window`): where it starts, and its ceiling. */
export interface AdaptiveWindow {
  /**
   * What a port this mux opens asks for, and the most a port the peer opens
   * starts with (the clamp of #145); the window grows from there.
   */
  initial: number;
  /** The most this end ever grants on one port: what one port may hold of its memory. */
  max: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

/** What `window: "auto"` means: 256 KiB to start, at most 16 MiB per port. */
export const DEFAULT_AUTO_WINDOW: Readonly<AdaptiveWindow> = Object.freeze({
  initial: 256 * KiB,
  max: 16 * MiB,
});

/** An RTT sample at most this far above the minimum is "near" it (with {@link NEAR_SLACK_MS}). */
const NEAR_FACTOR = 1.25;
/** Absolute slack, in ms, on "near the minimum": timer and event-loop jitter. */
const NEAR_SLACK_MS = 1;
/** An RTT sample past this multiple of the minimum is "inflated" (with {@link INFLATED_SLACK_MS}). */
const INFLATED_FACTOR = 2;
/** Absolute slack, in ms, on "inflated". */
const INFLATED_SLACK_MS = 2;
/** A minimum RTT not seen again for this long is replaced by the latest sample: the path changed. */
const MIN_RTT_LIFETIME_MS = 10_000;

/**
 * @internal The receive side of one port with an adaptive window: when to
 * grant the peer a larger or a smaller window, like TCP's receive-buffer
 * autotuning.
 *
 * It measures one round at a time. A round starts when this end sends a
 * credit that moves the window's right edge (`onGrant`): the bytes past the
 * old edge can only leave the peer once that credit has reached it, so the
 * first of them to arrive (`onArrived`) ends the round, and the round's
 * length is a round-trip time — the network's, plus whatever queue the bytes
 * waited in, but not this end's consumer.
 *
 * - The round's RTT stays near its minimum and the consumer took at least
 *   half a window during it (the port was limited by its window, not by its
 *   reader or its writer): the window doubles, up to the ceiling.
 * - The round's RTT inflated past twice the minimum (bytes queue somewhere,
 *   or the path got longer): the window shrinks by a quarter, down to the
 *   floor.
 *
 * Nothing here touches the wire: the mux announces `target` in its credits.
 */
export class WindowTuner {
  /** The window this end wants to grant now, in `[floor, ceiling]`. */
  target: number;
  private minRtt: number | undefined;
  private minRttAt = 0;
  private probe: { edge: number; at: number; consumed: number; window: number } | undefined;

  constructor(
    readonly floor: number,
    readonly ceiling: number,
  ) {
    this.target = floor;
  }

  /**
   * This end sent a credit at `now`, which moved the window's right edge
   * (bytes granted plus the window announced) from `edge` to `after`;
   * `consumed`: bytes consumed so far; `window`: the window announced before
   * it. Starts a round unless one is running, and only when the edge moved:
   * a shrinking credit that keeps it in place releases no byte, and a round
   * timed from it would count the consumer's and the batching's delay as
   * round trip, read as inflation.
   */
  onGrant(now: number, edge: number, after: number, consumed: number, window: number): void {
    if (after <= edge) return;
    this.probe ??= { edge, at: now, consumed, window };
  }

  /**
   * Bytes arrived at `now`: `arrived` in all, `consumed` consumed so far.
   * `true` when it ended a round and changed `target`.
   */
  onArrived(now: number, arrived: number, consumed: number): boolean {
    const probe = this.probe;
    if (!probe || arrived <= probe.edge) return false;
    this.probe = undefined;
    return this.onRound(now, now - probe.at, consumed - probe.consumed, probe.window);
  }

  /** One round: its RTT `rtt`, and what the consumer took during it with `window` granted. */
  onRound(now: number, rtt: number, consumed: number, window: number): boolean {
    if (
      this.minRtt === undefined ||
      rtt <= this.minRtt ||
      now - this.minRttAt > MIN_RTT_LIFETIME_MS
    ) {
      this.minRtt = rtt;
      this.minRttAt = now;
    }
    const before = this.target;
    if (rtt > this.minRtt * INFLATED_FACTOR + INFLATED_SLACK_MS) {
      this.target = Math.max(this.floor, Math.floor((this.target * 3) / 4));
    } else if (rtt <= this.minRtt * NEAR_FACTOR + NEAR_SLACK_MS && consumed * 2 >= window) {
      this.target = Math.min(this.ceiling, this.target * 2);
    }
    return this.target !== before;
  }
}

/** What `PortMuxOptions.window` resolves to. */
export interface ResolvedWindow {
  /** What a port this mux opens asks for in its `open`; unset: no window. */
  ask: number | undefined;
  /** The most a port the peer opens is granted at its open (the clamp of #145). */
  grant: number | undefined;
  /** The ceiling of an adaptive window; unset: the window is fixed. */
  max?: number;
}

/** @internal Reads `PortMuxOptions.window`; a plain number (or none) means what it always meant. */
export function resolveWindow(window: PortWindow | undefined): ResolvedWindow {
  if (window === undefined || typeof window === "number") return { ask: window, grant: window };
  const { initial, max } = window === "auto" ? DEFAULT_AUTO_WINDOW : (window ?? {});
  const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!(positive(initial) && positive(max) && initial <= max)) {
    throw new RangeError(
      `webrun-rpc: window must be a number, "auto" or { initial, max } with positive integers, initial <= max; got ${JSON.stringify(window)}`,
    );
  }
  // A peer's port starts at `initial` too, never at the ceiling: the opener
  // names the window it asks for, and a hostile or older one asking for the
  // ceiling would otherwise commit it at once, as the floor it never leaves.
  return { ask: initial, grant: initial, max };
}
