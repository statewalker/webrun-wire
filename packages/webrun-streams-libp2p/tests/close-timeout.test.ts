import type { Stream } from "@libp2p/interface";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  closeStream,
} from "../src/duplex-over-stream.js";

/**
 * A stream whose `close()` settles after `closeMs` — which is what a real close
 * does, because it waits for the write queue to DRAIN. Under concurrency that
 * queue is shared, so draining one stream legitimately takes far longer than it
 * would alone.
 *
 * Real timers throughout: `closeStream` bounds itself with
 * `AbortSignal.timeout`, which vitest's fake timers do not govern — under fake
 * timers the bound never fires and every assertion passes for the wrong reason.
 */
function slowStream(closeMs: number): Stream & { aborted: boolean } {
  const s = {
    protocol: "/close-timeout/1.0.0",
    aborted: false,
    async close(opts?: { signal?: AbortSignal }): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, closeMs);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("The operation was aborted due to timeout"));
        });
      });
    },
    abort(): void {
      s.aborted = true;
    },
  };
  return s as unknown as Stream & { aborted: boolean };
}

describe("closeStream's bound", () => {
  it("lets a slow close finish instead of resetting it", async () => {
    const stream = slowStream(150);
    await closeStream(stream, 2_000);
    expect(stream.aborted).toBe(false);
  });

  // The bound must still exist: it is there for a peer that has stopped reading
  // altogether and will never close, which would otherwise park the caller
  // forever. Generous, not absent.
  it("still aborts a close that never settles, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = slowStream(60_000);
    await closeStream(stream, 100);
    expect(stream.aborted).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("truncated");
    warn.mockRestore();
  });

  // THE BUG THIS FIXES. 18 concurrent 3.5 MB transfers over one muxer: draining
  // any one stream's write queue takes well over five seconds, close() was
  // aborted, the reset truncated the body, and the receiving page showed a
  // broken image. Reproduced end to end at 5 of 22 images decoded.
  //
  // Both bounds guard the same thing -- a peer that is alive but not reading --
  // so a close budget far tighter than the drain budget resets exactly the
  // slow-but-healthy transfers the drain budget was made generous to protect.
  it("is at least as generous as the drain bound it shares a failure mode with", () => {
    expect(DEFAULT_CLOSE_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_DRAIN_TIMEOUT_MS);
  });

  it("is exported, so a deployment can override it knowingly", () => {
    expect(typeof DEFAULT_CLOSE_TIMEOUT_MS).toBe("number");
    expect(DEFAULT_CLOSE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
