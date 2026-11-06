// PROTOTYPE T-1: is 2x reachable over a MessageChannel?
import { describe, expect, it } from "vitest";
import { type Mode, throughput } from "./harness.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const RUNS = Number(process.env.RUNS ?? 3);

const sizes = [
  { size: 256, count: 8192 }, // 2 MiB in 256 B chunks
  { size: 4 * KiB, count: 2048 }, // 8 MiB in 4 KiB chunks
];
const configs: Array<{ mode: Mode; window?: number }> = [
  { mode: "today" },
  { mode: "h1", window: 256 * KiB },
  { mode: "h1", window: MiB },
  { mode: "h2", window: 256 * KiB },
  { mode: "h2", window: MiB },
];

describe("T-1 throughput, connect/serve over overPipe + structuredCodec on a MessageChannel", () => {
  for (const { size, count } of sizes) {
    it(`body of ${count} x ${size} B: pipelined >= 2x today`, async () => {
      const rows: Record<string, number> = {};
      for (const { mode, window } of configs) {
        const label = window ? `${mode}@${window / KiB}KiB` : mode;
        rows[label] = await throughput(mode, window, size, count, RUNS);
      }
      const today = rows.today as number;
      const table = Object.entries(rows).map(
        ([k, v]) => `${k.padEnd(14)} ${v.toFixed(1).padStart(8)} MB/s  ${(v / today).toFixed(2)}x`,
      );
      console.log(`\n[T-1] ${count} x ${size} B (median of ${RUNS})\n${table.join("\n")}`);
      const best = Math.max(
        ...Object.entries(rows)
          .filter(([k]) => k !== "today")
          .map(([, v]) => v),
      );
      expect(best / today).toBeGreaterThanOrEqual(2);
    }, 300_000);
  }
});
