import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_WINDOW } from "../src/index.js";
import { resolveWindow, WindowTuner } from "../src/window-tuner.js";

// #188: the receive side's adaptation, on explicit time — no clock, no flakes.
// A round is one credit (`onGrant`) and the first byte past its old edge
// (`onArrived`); see `WindowTuner`.

const KiB = 1024;

/**
 * Runs `n` rounds of `rtt` ms in which the consumer took `share` of the
 * window granted at the round's start. Returns the target after each round.
 */
function rounds(
  tuner: WindowTuner,
  clock: { now: number },
  n: number,
  rtt: number,
  share = 1,
  state = { granted: 0, consumed: 0, window: tuner.target },
): number[] {
  const seen: number[] = [];
  for (let i = 0; i < n; i++) {
    const edge = state.granted + state.window;
    tuner.onGrant(clock.now, edge, state.consumed, state.window);
    clock.now += rtt;
    state.consumed += Math.floor(state.window * share);
    state.granted = state.consumed;
    tuner.onArrived(clock.now, edge + 1, state.consumed);
    state.window = tuner.target;
    seen.push(tuner.target);
  }
  return seen;
}

describe("WindowTuner: grow under window-limited flow at a low RTT", () => {
  it("doubles each round while the RTT stays at its minimum and the consumer takes the window", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    const clock = { now: 1000 };
    expect(rounds(tuner, clock, 4, 10)).toEqual([32, 64, 128, 256].map((n) => n * KiB));
  });

  it("does not grow when the consumer took less than half a window in a round (a slow reader)", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    const clock = { now: 1000 };
    expect(rounds(tuner, clock, 10, 10, 0.25)).toEqual(Array(10).fill(16 * KiB));
  });

  it("a round ends only with a byte past the edge the credit left behind", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    tuner.onGrant(0, 16 * KiB, 0, 16 * KiB);
    expect(tuner.onArrived(5, 16 * KiB, 16 * KiB)).toBe(false);
    expect(tuner.target).toBe(16 * KiB);
    expect(tuner.onArrived(6, 16 * KiB + 1, 16 * KiB)).toBe(true);
    expect(tuner.target).toBe(32 * KiB);
  });

  it("one round at a time: a credit sent while a round runs does not restart it", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    tuner.onGrant(0, 16 * KiB, 0, 16 * KiB);
    tuner.onGrant(50, 20 * KiB, 4 * KiB, 16 * KiB);
    tuner.onArrived(100, 16 * KiB + 1, 16 * KiB);
    // The round ran from 0, so its RTT is 100: the first sample is the minimum.
    tuner.onGrant(100, 40 * KiB, 16 * KiB, 32 * KiB);
    expect(tuner.onArrived(160, 40 * KiB + 1, 48 * KiB)).toBe(true);
    expect(tuner.target).toBe(64 * KiB);
  });
});

describe("WindowTuner: shrink on RTT inflation", () => {
  it("shrinks by a quarter per round once the RTT passes twice its minimum, down to the floor", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    const clock = { now: 1000 };
    const state = { granted: 0, consumed: 0, window: tuner.target };
    rounds(tuner, clock, 4, 10, 1, state);
    expect(tuner.target).toBe(256 * KiB);
    const shrinking = rounds(tuner, clock, 12, 50, 1, state);
    expect(shrinking.slice(0, 3)).toEqual([192 * KiB, 144 * KiB, 108 * KiB]);
    for (let i = 1; i < shrinking.length; i++) {
      expect(shrinking[i]).toBeLessThanOrEqual(shrinking[i - 1] as number);
    }
    expect(shrinking.at(-1)).toBe(16 * KiB);
  });

  it("neither grows nor shrinks between near the minimum and inflated", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    const clock = { now: 1000 };
    const state = { granted: 0, consumed: 0, window: tuner.target };
    rounds(tuner, clock, 2, 10, 1, state);
    expect(rounds(tuner, clock, 5, 18, 1, state)).toEqual(Array(5).fill(64 * KiB));
  });

  it("a minimum RTT not seen for 10 s gives way to the latest: a longer path is not inflation forever", () => {
    const tuner = new WindowTuner(16 * KiB, 1024 * KiB);
    const clock = { now: 1000 };
    const state = { granted: 0, consumed: 0, window: tuner.target };
    rounds(tuner, clock, 3, 10, 1, state);
    expect(tuner.target).toBe(128 * KiB);
    // The path now takes 100 ms: inflated, so the window shrinks...
    rounds(tuner, clock, 3, 100, 1, state);
    expect(tuner.target).toBeLessThan(128 * KiB);
    // ...until the old minimum expires; then it grows again at the new RTT.
    clock.now += 10_001;
    const after = rounds(tuner, clock, 3, 100, 1, state);
    expect(after[2]).toBeGreaterThan(after[0] as number);
  });
});

describe("WindowTuner: bounds", () => {
  it("never passes the ceiling, however long the flow stays window-limited", () => {
    const tuner = new WindowTuner(16 * KiB, 100 * KiB);
    const clock = { now: 0 };
    const seen = rounds(tuner, clock, 20, 5);
    expect(Math.max(...seen)).toBe(100 * KiB);
    for (const target of seen) expect(target).toBeLessThanOrEqual(100 * KiB);
  });

  it("never goes below the floor", () => {
    const tuner = new WindowTuner(16 * KiB, 100 * KiB);
    const clock = { now: 0 };
    rounds(tuner, clock, 1, 5);
    for (const target of rounds(tuner, clock, 20, 500)) {
      expect(target).toBeGreaterThanOrEqual(16 * KiB);
    }
  });
});

describe("resolveWindow", () => {
  it("a plain number, or none, is what it always was: asked for and granted at most", () => {
    expect(resolveWindow(64 * KiB)).toEqual({ ask: 64 * KiB, grant: 64 * KiB });
    expect(resolveWindow(undefined)).toEqual({ ask: undefined, grant: undefined });
  });

  it('`{ initial, max }` asks for initial and grants at most max; "auto" is DEFAULT_AUTO_WINDOW', () => {
    expect(resolveWindow({ initial: 16 * KiB, max: 1024 * KiB })).toEqual({
      ask: 16 * KiB,
      grant: 1024 * KiB,
      max: 1024 * KiB,
    });
    expect(resolveWindow("auto")).toEqual({
      ask: DEFAULT_AUTO_WINDOW.initial,
      grant: DEFAULT_AUTO_WINDOW.max,
      max: DEFAULT_AUTO_WINDOW.max,
    });
    expect(DEFAULT_AUTO_WINDOW).toEqual({ initial: 256 * KiB, max: 16 * 1024 * KiB });
  });

  it("refuses an adaptive window that is not positive integers with initial <= max", () => {
    for (const bad of [
      { initial: 0, max: 10 },
      { initial: 20, max: 10 },
      { initial: 1.5, max: 10 },
      { initial: 10 },
      "fast",
    ]) {
      expect(() => resolveWindow(bad as never), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});
