import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_WINDOW } from "../src/index.js";
import {
  type AdaptiveWindow,
  adaptiveWindowOf,
  RttFilter,
  resolveWindow,
  WindowTuner,
} from "../src/window-tuner.js";

// #188: the receive side's adaptation, on a simulated link and explicit time
// (no clock, no flakes). Ported from the statewalker/httpeers#128 prototype,
// onto this mux's grants: a smaller window is reached by granting less, so the
// right edge (bytes granted plus the window) never moves back.

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * A sender that always has data, behind a link of `rate` bytes/ms and base
 * round trip `rttMs`, with a FIFO queue (sender buffers plus bottleneck) that
 * holds whatever is in flight past one BDP. The receiver consumes at once and
 * grants each message's bytes back as it arrives, as the mux does: the window
 * it announces is max(target, last − bytes), and a larger target goes out at
 * once. Time advances in steps of about one message, so the run is
 * deterministic.
 */
function simulate(opts: {
  tuner: WindowTuner;
  rate: number;
  rttMs: number;
  durationMs: number;
  message?: number;
  /** Bytes the sender has to send in all (default: unbounded). */
  appBytes?: number;
  /** Receiver-side backlog the consumer never drains (a slow reader). */
  unconsumed?: number;
  budgetRoom?: number;
}) {
  const { tuner, rate, rttMs, durationMs } = opts;
  const message = opts.message ?? 16 * KiB;
  let now = 0;
  let sent = 0;
  let received = 0;
  // The receiver: what it granted, and the window it last announced.
  let granted = 0;
  let announced = tuner.window;
  // The sender: what credit reached it, and the latest window it heard.
  let creditReceived = 0;
  let sendWindow = tuner.window;
  const toSender: { at: number; bytes: number; window?: number }[] = [];
  const pending: { at: number; bytes: number }[] = [];
  const windows: number[] = [];
  const edges: number[] = [];
  let overshoot = Number.NEGATIVE_INFINITY;
  const grantNow = (bytes: number) => {
    const next = Math.max(tuner.window, announced - bytes);
    const edge = granted + announced;
    granted += bytes;
    const changed = next !== announced;
    announced = next;
    tuner.granted(edge, granted + announced, now);
    edges.push(granted + announced);
    if (changed) windows.push(next);
    toSender.push({ at: now + rttMs / 2, bytes, ...(changed ? { window: next } : {}) });
  };
  while (now < durationMs) {
    while (toSender.length && (toSender[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const g = toSender.shift();
      if (!g) break;
      creditReceived += g.bytes;
      if (g.window != null) sendWindow = g.window;
    }
    const credit = creditReceived + sendWindow - sent;
    const app = opts.appBytes == null ? Number.POSITIVE_INFINITY : opts.appBytes - sent;
    if (credit >= message && app >= message) {
      const inFlight = sent - received;
      const queueMs = Math.max(0, inFlight - rate * rttMs) / rate;
      pending.push({ at: now + rttMs / 2 + queueMs + message / rate, bytes: message });
      sent += message;
      // Never past what the receiver accepts: its edge.
      overshoot = Math.max(overshoot, sent - (granted + announced));
    }
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && (pending[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const m = pending.shift();
      if (!m) break;
      received += m.bytes;
      tuner.received(received, now);
      tuner.adjust(now, opts.unconsumed ?? 0, () => opts.budgetRoom ?? Number.POSITIVE_INFINITY);
      if (tuner.window > announced) grantNow(0);
      grantNow(m.bytes);
    }
    now += Math.max(0.05, Math.min(message / rate, 1));
  }
  return { received, windows, edges, overshoot, rate: received / durationMs };
}

const sizes = (initial: number, more: Partial<AdaptiveWindow> = {}) =>
  adaptiveWindowOf({ initial, min: more.min ?? 64 * KiB, max: more.max ?? 16 * MiB });
/** A port agreed at `agreed`, wanting `window` now (a port that grew there). */
const tunerOf = (agreed: number, more: Partial<AdaptiveWindow> = {}, window = agreed) => {
  const t = new WindowTuner(sizes(agreed, more), new RttFilter(), agreed);
  t.window = window;
  return t;
};

describe("RttFilter", () => {
  it("keeps the minimum and lets it rise only after its window passes", () => {
    const f = new RttFilter(1000);
    f.update(50, 0);
    f.update(40, 10);
    f.update(80, 500);
    expect(f.get()).toBe(40);
    f.update(70, 1200);
    f.update(60, 2100);
    expect(f.get()).toBeGreaterThanOrEqual(60);
    expect(f.get()).toBeLessThanOrEqual(70);
  });
});

describe("WindowTuner: what it measures", () => {
  it("measures the round trip from a credit to the first byte past the edge it moved", () => {
    const rtt = new RttFilter();
    const t = new WindowTuner(sizes(100, { min: 10, max: 1000 }), rtt, 100);
    t.granted(100, 150, 5);
    t.received(100, 20);
    expect(rtt.get()).toBe(Number.POSITIVE_INFINITY);
    t.received(110, 35);
    expect(rtt.get()).toBe(30);
  });

  it("a credit that does not move the right edge (a shrinking one) starts no round", () => {
    const rtt = new RttFilter();
    const t = new WindowTuner(sizes(1000, { min: 100, max: 1000 }), rtt, 1000);
    // 50 bytes granted and the window 50 smaller: the edge stays at 1000.
    t.granted(1000, 1000, 1);
    // A byte past 1000 was released by an earlier credit, not this one.
    t.received(1010, 50);
    expect(rtt.get()).toBe(Number.POSITIVE_INFINITY);
    t.granted(1010, 1060, 60);
    t.received(1020, 100);
    expect(rtt.get()).toBe(40);
  });

  it("a credit posted after bytes already passed its old edge gives no sample", () => {
    const rtt = new RttFilter();
    const t = new WindowTuner(sizes(1000, { min: 100, max: 1000 }), rtt, 1000);
    t.received(1200, 0);
    t.granted(1000, 1500, 1);
    t.received(1300, 9);
    expect(rtt.get()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("WindowTuner on a simulated link", () => {
  it("grows while a port is window-limited and the round trip stays at its minimum (long fat pipe)", () => {
    const t = tunerOf(256 * KiB);
    const r = simulate({ tuner: t, rate: 12_500, rttMs: 100, durationMs: 4000 });
    expect(t.window).toBeGreaterThanOrEqual(1.25e6);
    expect(t.window).toBeLessThanOrEqual(4 * 1.25e6);
    expect(Math.max(...r.windows)).toBeGreaterThan(256 * KiB);
    expect(r.overshoot).toBeLessThanOrEqual(0);
  });

  it("shrinks when the round trip under load inflates (a window larger than the BDP), never moving the edge back", () => {
    const t = tunerOf(64 * KiB, {}, 1 * MiB);
    const r = simulate({ tuner: t, rate: 1250, rttMs: 80, durationMs: 8000 });
    expect(t.window).toBeLessThan(400 * KiB);
    expect(t.window).toBeGreaterThanOrEqual(64 * KiB);
    for (let i = 1; i < r.edges.length; i++) {
      expect(r.edges[i]).toBeGreaterThanOrEqual(r.edges[i - 1] as number);
    }
    expect(r.overshoot).toBeLessThanOrEqual(0);
  });

  it("holds a window that is about one BDP", () => {
    const t = tunerOf(256 * KiB, { min: 64 * KiB });
    simulate({ tuner: t, rate: 6250, rttMs: 30, durationMs: 4000 });
    expect(t.window).toBeGreaterThanOrEqual(128 * KiB);
    expect(t.window).toBeLessThanOrEqual(512 * KiB);
  });

  it("stays within the floor and the ceiling", () => {
    const big = tunerOf(256 * KiB, { max: 512 * KiB });
    const r0 = simulate({ tuner: big, rate: 12_500, rttMs: 100, durationMs: 4000 });
    expect(Math.max(...r0.windows)).toBe(512 * KiB);
    expect(big.window).toBe(512 * KiB);
    const small = tunerOf(128 * KiB, { min: 128 * KiB }, 256 * KiB);
    const r = simulate({ tuner: small, rate: 125, rttMs: 200, durationMs: 30_000 });
    expect(Math.min(...r.windows)).toBe(128 * KiB);
    expect(small.window).toBeLessThanOrEqual(2 * 128 * KiB);
  });

  it("never goes below the window agreed for the port, whatever `min` says", () => {
    const t = tunerOf(256 * KiB, { min: 16 * KiB }, 1 * MiB);
    expect(t.floor).toBe(256 * KiB);
    const r = simulate({ tuner: t, rate: 125, rttMs: 200, durationMs: 20_000 });
    expect(Math.min(...r.windows)).toBeGreaterThanOrEqual(256 * KiB);
  });

  it("does not grow for a sender that does not fill its window", () => {
    const t = tunerOf(256 * KiB);
    simulate({ tuner: t, rate: 12_500, rttMs: 100, durationMs: 2000, appBytes: 64 * KiB });
    expect(t.window).toBe(256 * KiB);
  });

  it("does not grow while this side's reader is behind", () => {
    const t = tunerOf(256 * KiB);
    simulate({ tuner: t, rate: 12_500, rttMs: 100, durationMs: 4000, unconsumed: 200 * KiB });
    expect(t.window).toBe(256 * KiB);
  });

  it("grows no further than the mux's budget allows", () => {
    const t = tunerOf(256 * KiB);
    simulate({ tuner: t, rate: 12_500, rttMs: 100, durationMs: 4000, budgetRoom: 0 });
    expect(t.window).toBe(256 * KiB);
  });
});

describe("adaptive window options", () => {
  it("a plain number, or none, is what it always was: asked for and granted at most", () => {
    expect(resolveWindow(64 * KiB)).toEqual({ ask: 64 * KiB, grant: 64 * KiB });
    expect(resolveWindow(undefined)).toEqual({ ask: undefined, grant: undefined });
  });

  it("an adaptive window asks for initial, starts a peer's port at initial too, and fills in defaults", () => {
    expect(resolveWindow({ initial: 16 * KiB, max: 1024 * KiB })).toEqual({
      ask: 16 * KiB,
      grant: 16 * KiB,
      adaptive: { initial: 16 * KiB, min: 16 * KiB, max: 1024 * KiB, budget: 4096 * KiB },
    });
    expect(resolveWindow("auto")).toEqual({
      ask: 256 * KiB,
      grant: 256 * KiB,
      adaptive: DEFAULT_AUTO_WINDOW,
    });
    expect(DEFAULT_AUTO_WINDOW).toEqual({
      initial: 256 * KiB,
      min: 64 * KiB,
      max: 16 * MiB,
      budget: 64 * MiB,
    });
  });

  it("refuses sizes that cannot work", () => {
    for (const bad of [
      { initial: 0, max: 10 },
      { initial: 20, max: 10 },
      { initial: 1.5, max: 10 },
      { initial: 10, min: 20, max: 30 },
      { initial: 10, max: 30, budget: 20 },
      { initial: 10 },
      "fast",
    ]) {
      expect(() => resolveWindow(bad as never), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});
