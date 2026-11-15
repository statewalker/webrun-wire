/**
 * THE ADAPTIVE WINDOW (`PortMuxOptions.window` as `AdaptiveWindow` or
 * `"auto"`, statewalker/webrun-wire#188): the receive side of a port sizes the
 * window it grants to about one bandwidth-delay product (BDP) of the path,
 * from what it observes alone. The controller comes from the prototype the
 * statewalker/httpeers#128 session ran against httpeers' emulated-link bench.
 *
 * WHY THE RECEIVER. The window bounds what this side may have to hold for the
 * port, so only this side sets it. The sender never sends past what was
 * granted, and cannot make the receiver hold more.
 *
 * WHAT IT MEASURES. A credit that moves the window's right edge (bytes
 * granted plus the window) releases bytes the sender could not send before,
 * and the first byte past the old edge can only have left once that credit
 * arrived. The time from posting the credit to that byte is one round trip
 * plus whatever delayed the byte: queueing in the sender's buffers and at the
 * bottleneck, but not this side's consumer. Its minimum over time
 * (`RttFilter`, shared by a mux's ports since they share the path) is the
 * base round trip. The receiver never moves the right edge back (a smaller
 * window is reached by granting less as the consumer frees bytes), so a byte
 * past an edge was always released by the credit that set it.
 *
 * WHAT IT DECIDES, once per round (about one round trip, at least 20 ms):
 *
 * - **grow** (×2, or ×1.25 once a growth was taken back; within the ceiling
 *   and the mux's budget) while the sender fills the window (the rate times
 *   the round trip is at least half the window), the round trip stays near
 *   its minimum, and this side's reader is not behind. Every growth is
 *   JUDGED: a settle round, then the mean rate over about 60 ms of rounds
 *   against the mean at the old window; under 5% more and the growth is
 *   taken back, and the next one waits 4 rounds × 2^failures (at most 64);
 * - **shrink** toward 1.5 × the rate × the base round trip, at most halving
 *   per round, when the round trip inflates well above its minimum: the
 *   extra window only waits in a queue, where it delays every other port on
 *   the same path;
 * - **probe** (like BBR's ProbeRTT) once the port fills its window, and every
 *   10 s after: drop to the floor until a sample shows the queue drained (or
 *   two base round trips pass), then take the window back, with two rounds
 *   after it that decide nothing. A port that starts above the BDP has a
 *   queue from its first byte, and without draining it would learn a base
 *   round trip that includes it;
 * - otherwise **hold**.
 *
 * THE FLOOR is never below the window agreed for the port: a peer of an
 * earlier version ignores the window a credit announces and keeps counting
 * against the agreed one, so no capability gates any of this.
 */

/** The window a port grants its peer (`PortMuxOptions.window`). */
export type PortWindow = number | AdaptiveWindow | "auto";

/** Sizing of an adaptive window, in bytes (`PortMuxOptions.window`). */
export interface AdaptiveWindow {
  /**
   * What a port this mux opens asks for, and the most a port the peer opens
   * starts with (the clamp of #145): the window grows from there.
   */
  initial: number;
  /**
   * The floor it never shrinks below. Default: the smaller of `initial` and
   * 64 KiB. Never below the window agreed for the port either.
   */
  min?: number;
  /** The ceiling it never grows past, per port: what one port may hold of this end's memory. */
  max: number;
  /**
   * Ceiling on what this mux's adaptive ports may grant in all, summed over
   * their windows. Default: 4 × `max`. A port grows only within what is left.
   */
  budget?: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

/** Default floor of an adaptive window (`AdaptiveWindow.min`), capped by `initial`. */
export const DEFAULT_ADAPTIVE_MIN_WINDOW = 64 * KiB;

/** What `window: "auto"` means: 256 KiB to start, 64 KiB floor, 16 MiB per port, 64 MiB per mux. */
export const DEFAULT_AUTO_WINDOW: Readonly<Required<AdaptiveWindow>> = Object.freeze({
  initial: 256 * KiB,
  min: DEFAULT_ADAPTIVE_MIN_WINDOW,
  max: 16 * MiB,
  budget: 64 * MiB,
});

/** How often a port that fills its window drains it to re-measure the base round trip. */
export const RTT_PROBE_INTERVAL_MS = 10_000;
/** How long a base round-trip sample stands: longer than the probe interval. */
export const RTT_FILTER_WINDOW_MS = 12_000;

/** Grow while the round trip stays within this factor of its minimum (plus `GROW_SLACK_MS`)... */
const GROW_RTT_FACTOR = 1.25;
const GROW_SLACK_MS = 5;
/** ...and shrink once it passes this factor (plus `SHRINK_SLACK_MS`). */
const SHRINK_RTT_FACTOR = 1.5;
const SHRINK_SLACK_MS = 10;
/** A round lasts at least this long: on a short path a round trip is event-loop noise. */
const MIN_ROUND_MS = 20;
/** The window a shrink aims at, in base-RTT BDPs of the delivery rate. */
const SHRINK_TARGET_BDPS = 1.5;
/** The rate times the round trip, as a share of the window, from which the sender fills it. */
const FILLED_SHARE = 0.5;
/** A growth that does not raise the mean delivery rate by this factor is taken back. */
const GROWTH_GAIN = 1.05;
/** The rounds that judge a growth span about this long (1 to `MAX_JUDGE_ROUNDS` rounds). */
const JUDGE_MS = 60;
const MAX_JUDGE_ROUNDS = 3;
/** After the first growth taken back, a port grows by this factor instead of doubling. */
const FINE_GROWTH = 1.25;
/** Rounds at one window that its mean rate is taken over, at most. */
const RATE_ROUNDS = 8;
/** No growth for this many rounds after one taken back or a shrink, × 2^failures, at most `MAX_HOLD_ROUNDS`. */
const HOLD_ROUNDS = 4;
const MAX_HOLD_ROUNDS = 64;
/** Rounds that decide nothing after a probe. */
const QUIET_ROUNDS = 2;

/**
 * The minimum of round-trip samples over a sliding window, kept as two
 * buckets: a sample older than `windowMs` stops counting, so the base round
 * trip can rise when the path changes.
 */
export class RttFilter {
  private current = Number.POSITIVE_INFINITY;
  private currentAt = 0;
  private next = Number.POSITIVE_INFINITY;
  private nextAt = 0;
  constructor(private readonly windowMs = RTT_FILTER_WINDOW_MS) {}

  update(sample: number, now: number): void {
    if (!(sample >= 0)) return;
    if (now - this.currentAt > this.windowMs) {
      // The current minimum expired: the newer bucket's takes over.
      this.current = this.next;
      this.currentAt = this.nextAt;
      this.next = Number.POSITIVE_INFINITY;
    }
    if (sample <= this.current) {
      this.current = sample;
      this.currentAt = now;
      this.next = Number.POSITIVE_INFINITY;
      return;
    }
    if (sample <= this.next || now - this.nextAt > this.windowMs / 2) {
      this.next = sample;
      this.nextAt = now;
    }
  }

  /** The base round trip in ms; `Infinity` before the first sample. */
  get(): number {
    return this.current;
  }
}

/** Validates and completes an `AdaptiveWindow`; a `RangeError` on sizes that cannot work. */
export function adaptiveWindowOf(window: AdaptiveWindow | "auto"): Required<AdaptiveWindow> {
  if (window === "auto") return { ...DEFAULT_AUTO_WINDOW };
  const given = (
    typeof window === "object" && window !== null ? window : {}
  ) as Partial<AdaptiveWindow>;
  const { initial, max } = given;
  const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!(positive(initial) && positive(max))) {
    throw new RangeError(
      `webrun-rpc: window must be a number, "auto" or { initial, min?, max, budget? } with positive integer sizes; got ${JSON.stringify(window)}`,
    );
  }
  const min = given.min ?? Math.min(initial, DEFAULT_ADAPTIVE_MIN_WINDOW);
  const budget = given.budget ?? 4 * max;
  const sizes = { initial, min, max, budget };
  if (!(positive(min) && positive(budget) && min <= initial && initial <= max && max <= budget)) {
    throw new RangeError(
      `webrun-rpc: an adaptive window needs positive integers with min <= initial <= max <= budget; got ${JSON.stringify(sizes)}`,
    );
  }
  return sizes;
}

/** What `PortMuxOptions.window` resolves to. */
export interface ResolvedWindow {
  /** What a port this mux opens asks for in its `open`; unset: no window. */
  ask: number | undefined;
  /** The most a port the peer opens is granted at its open (the clamp of #145). */
  grant: number | undefined;
  /** The sizes of an adaptive window; unset: the window is fixed. */
  adaptive?: Required<AdaptiveWindow>;
}

/** @internal Reads `PortMuxOptions.window`; a plain number (or none) means what it always meant. */
export function resolveWindow(window: PortWindow | undefined): ResolvedWindow {
  if (window === undefined || typeof window === "number") return { ask: window, grant: window };
  const adaptive = adaptiveWindowOf(window);
  // A peer's port starts at `initial` too, never at the ceiling: the opener
  // names the window it asks for, and a hostile or older one asking for the
  // ceiling would otherwise commit it at once, as the floor it never leaves.
  return { ask: adaptive.initial, grant: adaptive.initial, adaptive };
}

/**
 * @internal The receive window of one port: the window this side wants to
 * grant (`window`). The mux announces it; one smaller than what it last
 * announced it reaches by granting less. Time in ms, on a monotonic clock.
 */
export class WindowTuner {
  /** The window this side wants to grant now, in `[floor, max]`. */
  window: number;
  /** The least it grants: `min`, and never below the window agreed for the port. */
  readonly floor: number;
  private readonly max: number;
  /**
   * Credits not yet answered by a byte past their old edge. `drained`: when
   * it was posted, no more than the floor was in flight, so the sample it
   * gives carries no queue this port built.
   */
  private readonly grants: { before: number; at: number; drained: boolean }[] = [];
  private total = 0;
  private roundStart: number | undefined;
  private roundBytes = 0;
  private roundMin = Number.POSITIVE_INFINITY;
  private probe: { saved: number; until: number; clean: boolean } | undefined;
  private nextProbe: number | undefined;
  /** The last growth, until the rounds after it show whether it raised the rate. */
  private grew: { from: number; rate: number; settledAt: number; judgeAt: number } | undefined;
  /** Rates of the last rounds at the current window, since it settled. */
  private rates: number[] = [];
  private rounds = 0;
  private holdUntilRound = 0;
  private failedGrowths = 0;
  private quietUntilRound = 0;
  /** A growth was taken back once: grow by `FINE_GROWTH` from now on. */
  private fine = false;

  /**
   * `agreed`: the window agreed for the port, which the floor never goes
   * below. `received`: what has arrived on the port so far.
   */
  constructor(
    sizes: Required<AdaptiveWindow>,
    private readonly rtt: RttFilter,
    agreed: number,
    received = 0,
  ) {
    this.max = sizes.max;
    this.floor = Math.min(sizes.max, Math.max(sizes.min, agreed));
    this.window = this.floor;
    this.total = received;
  }

  /** The most this port may come to hold: its window, or the one a probe will take back. */
  reserved(): number {
    return Math.max(this.window, this.probe?.saved ?? 0);
  }

  /**
   * This side posted a credit at `now` that moved the right edge from `edge`
   * to `after`. Only a credit that moved it released bytes: a shrinking one
   * that keeps it in place gives no sample (its delay would be the consumer's
   * and the batching's, read as inflation), nor does one whose old edge the
   * bytes already passed.
   */
  granted(edge: number, after: number, now: number): void {
    if (after <= edge || edge < this.total) return;
    // In a probe, at most the floor in flight: no queue of this port's own.
    const drained = this.probe != null && edge - this.total <= this.floor;
    this.grants.push({ before: edge, at: now, drained });
  }

  /** `total` bytes have arrived on the port so far. */
  received(total: number, now: number): void {
    this.total = total;
    let sample: number | undefined;
    let drained = false;
    // The latest credit whose old edge is passed: the one this byte needed.
    while (this.grants.length && (this.grants[0]?.before ?? 0) < total) {
      const g = this.grants.shift();
      if (g) {
        sample = now - g.at;
        drained = g.drained;
      }
    }
    if (sample == null) return;
    this.rtt.update(sample, now);
    if (this.probe && drained) this.probe.clean = true;
    this.roundMin = Math.min(this.roundMin, sample);
    if (this.roundStart == null) {
      this.roundStart = now;
      this.roundBytes = total;
    }
  }

  private hold(round: number): void {
    this.holdUntilRound =
      round + Math.min(MAX_HOLD_ROUNDS, HOLD_ROUNDS * 2 ** Math.min(this.failedGrowths, 6));
  }

  private newRound(now: number): void {
    this.roundStart = now;
    this.roundBytes = this.total;
    this.roundMin = Number.POSITIVE_INFINITY;
  }

  private set(window: number): number {
    this.window = window;
    return window;
  }

  /**
   * The window to grant from now, when it changes; checked on every arrival,
   * it decides at most once per round. `unconsumed`: what this side's reader
   * has not taken yet; `room`: what the mux's budget leaves this port to grow
   * by past its window, asked only when it would grow.
   */
  adjust(now: number, unconsumed: number, room: () => number): number | undefined {
    if (this.probe) {
      if (!this.probe.clean && now < this.probe.until) return undefined;
      const { saved } = this.probe;
      this.probe = undefined;
      this.nextProbe = now + RTT_PROBE_INTERVAL_MS;
      this.newRound(now);
      this.rates = [];
      this.quietUntilRound = this.rounds + QUIET_ROUNDS;
      // The budget kept the saved window reserved (`reserved`).
      return saved > this.window ? this.set(saved) : undefined;
    }
    if (this.roundStart == null || this.roundMin === Number.POSITIVE_INFINITY) return undefined;
    const base = this.rtt.get();
    const rtt = this.roundMin;
    const span = now - this.roundStart;
    if (span < Math.max(rtt, base, MIN_ROUND_MS)) return undefined;
    const rate = (this.total - this.roundBytes) / span;
    this.newRound(now);

    const round = ++this.rounds;
    if (round <= this.quietUntilRound) return undefined;
    const grew = this.grew;
    // A growth shows in the rate only a round after the sender has it: the
    // round right after it settles, the next ones (about `JUDGE_MS`) judge it.
    if (grew && round <= grew.settledAt) return undefined;
    this.rates.push(rate);
    if (this.rates.length > RATE_ROUNDS) this.rates.shift();
    if (grew && round < grew.judgeAt) return undefined;
    const meanRate = this.rates.reduce((a, b) => a + b, 0) / this.rates.length;
    this.grew = undefined;
    if (grew && meanRate < GROWTH_GAIN * grew.rate && grew.from < this.window) {
      // More window did not deliver more: the path, not the window, limits it.
      this.failedGrowths++;
      this.fine = true;
      this.hold(round);
      this.rates = [];
      return this.set(grew.from);
    }
    if (grew) this.failedGrowths = 0;
    const filled = rate * rtt >= FILLED_SHARE * this.window;
    if (filled && this.window > this.floor && (this.nextProbe ?? now) <= now) {
      this.probe = { saved: this.window, until: now + 2 * Math.max(base, rtt), clean: false };
      return this.set(this.floor);
    }
    if (rtt <= base * GROW_RTT_FACTOR + GROW_SLACK_MS) {
      if (!filled || unconsumed > this.window / 2 || this.window >= this.max) return undefined;
      if (round < this.holdUntilRound) return undefined;
      const step = this.fine ? Math.ceil(FINE_GROWTH * this.window) : 2 * this.window;
      const grown = Math.min(this.max, step, this.window + Math.max(0, room()));
      if (grown <= this.window) return undefined;
      const judge = Math.min(MAX_JUDGE_ROUNDS, Math.max(1, Math.ceil(JUDGE_MS / span)));
      this.grew = {
        from: this.window,
        rate: meanRate,
        settledAt: round + 1,
        judgeAt: round + 1 + judge,
      };
      this.rates = [];
      return this.set(grown);
    }
    if (rtt > base * SHRINK_RTT_FACTOR + SHRINK_SLACK_MS) {
      const target = Math.ceil(rate * base * SHRINK_TARGET_BDPS);
      const shrunk = Math.max(
        this.floor,
        Math.ceil(this.window / 2),
        Math.min(this.window, target),
      );
      if (shrunk >= this.window) return undefined;
      this.hold(round);
      this.rates = [];
      return this.set(shrunk);
    }
    return undefined;
  }
}
