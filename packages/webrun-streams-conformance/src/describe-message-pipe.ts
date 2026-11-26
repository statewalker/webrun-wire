import type { MessagePipe } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";

/**
 * One adapter's pipe over a fake (or real) transport, with handles to drive
 * the transport from the outside.
 */
export interface MessagePipeHarness {
  /** What the adapter returned: `{ target, signal, maxMessageSize }`. */
  pipe: MessagePipe;
  /** The transport delivers one inbound message, as the adapter's transport would. */
  inject(data: unknown): void | Promise<void>;
  /** What the adapter has put on the transport so far, one entry per message. */
  sent(): Uint8Array[] | Promise<Uint8Array[]>;
  /** The transport ends on its own (the peer went away). */
  endRemotely(): void | Promise<void>;
  /** Makes the transport report `bytes` buffered. Absent: the drain cases are skipped. */
  setBuffered?(bytes: number): void;
  /** Lets the adapter see buffered bytes go down, where it needs an event for it. */
  settle?(): void | Promise<void>;
  /** Releases anything the harness holds. */
  dispose?(): void | Promise<void>;
}

export interface DescribeMessagePipeOptions {
  /** Build a pipe with this frame ceiling. Absent: the ceiling cases are skipped. */
  withMaxFrameBytes?: (maxFrameBytes: number) => MessagePipeHarness | Promise<MessagePipeHarness>;
  /** The adapter's drain low-water mark. Default 256 KiB. */
  drainLowWater?: number;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The contract every pipe of byte messages keeps (statewalker/webrun-wire#151),
 * run against an adapter through its harness. The pipe module
 * (`newMessagePipe` in `@statewalker/webrun-streams`) implements it once; each
 * `webrun-streams-*` adapter runs this suite to show it still does.
 */
export function describeMessagePipe(
  name: string,
  make: () => MessagePipeHarness | Promise<MessagePipeHarness>,
  options: DescribeMessagePipeOptions = {},
): void {
  const lowWater = options.drainLowWater ?? 256 * 1024;

  async function withHarness(
    build: () => MessagePipeHarness | Promise<MessagePipeHarness>,
    body: (h: MessagePipeHarness) => Promise<void>,
  ): Promise<void> {
    const h = await build();
    try {
      await body(h);
    } finally {
      await h.dispose?.();
    }
  }

  describe(`${name}: the message pipe contract`, () => {
    it("carries its own life and ceiling: target.closeSignal is the signal, target.maxMessageSize the ceiling", () =>
      withHarness(make, async ({ pipe }) => {
        expect(pipe.target.closeSignal).toBe(pipe.signal);
        expect(pipe.target.maxMessageSize).toBe(pipe.maxMessageSize);
      }));

    it("delivers inbound bytes to every listener as Uint8Array, in order, past a faulty listener", () =>
      withHarness(make, async (h) => {
        const got: number[][] = [];
        const other: number[][] = [];
        h.pipe.target.addEventListener("message", () => {
          throw new Error("a faulty listener");
        });
        h.pipe.target.addEventListener("message", async () => {
          throw new Error("a rejecting listener");
        });
        h.pipe.target.addEventListener("message", (e) => {
          expect(e.data).toBeInstanceOf(Uint8Array);
          got.push([...(e.data as Uint8Array)]);
        });
        const removed = (e: MessageEvent) => {
          other.push([...(e.data as Uint8Array)]);
        };
        h.pipe.target.addEventListener("message", removed);
        h.pipe.target.removeEventListener("message", removed);
        await h.inject(new Uint8Array([1, 2]));
        await h.inject(new Uint8Array([3]).buffer);
        await h.inject(new Uint8Array([9, 4, 9]).subarray(1, 2));
        await flush();
        expect(got).toEqual([[1, 2], [3], [4]]);
        expect(other).toEqual([]);
        expect(h.pipe.signal.aborted).toBe(false);
      }));

    it("sends bytes one message each, and refuses anything else with TypeError", () =>
      withHarness(make, async (h) => {
        h.pipe.target.postMessage(new Uint8Array([1, 2, 3]));
        h.pipe.target.postMessage(new Uint8Array([4, 5]).buffer);
        expect(() => h.pipe.target.postMessage("text")).toThrow(TypeError);
        expect(() => h.pipe.target.postMessage({ a: 1 })).toThrow(TypeError);
        await flush();
        expect((await h.sent()).map((b) => [...b])).toEqual([
          [1, 2, 3],
          [4, 5],
        ]);
      }));

    it("ends when the transport ends: the signal aborts with an Error, and a post is a no-op", () =>
      withHarness(make, async (h) => {
        await h.endRemotely();
        await flush();
        expect(h.pipe.signal.aborted).toBe(true);
        expect(h.pipe.signal.reason).toBeInstanceOf(Error);
        const before = (await h.sent()).length;
        h.pipe.target.postMessage(new Uint8Array([1]));
        await flush();
        expect((await h.sent()).length).toBe(before);
      }));

    it("close() ends the pipe: the signal aborts, and nothing more is delivered", () =>
      withHarness(make, async (h) => {
        const got: unknown[] = [];
        h.pipe.target.addEventListener("message", (e) => {
          got.push(e.data);
        });
        await h.pipe.target.close();
        expect(h.pipe.signal.aborted).toBe(true);
        await h.inject(new Uint8Array([1]));
        await flush();
        expect(got).toEqual([]);
        // A second close is harmless.
        await h.pipe.target.close();
      }));

    it("close(reason) ends the pipe with that reason, an Error as given and anything else wrapped", async () => {
      await withHarness(make, async (h) => {
        const reason = new Error("the other side ended");
        await h.pipe.target.close(reason);
        expect(h.pipe.signal.aborted).toBe(true);
        expect(h.pipe.signal.reason).toBe(reason);
        // A later close keeps the first reason.
        await h.pipe.target.close(new Error("later"));
        expect(h.pipe.signal.reason).toBe(reason);
      });
      await withHarness(make, async (h) => {
        await h.pipe.target.close("gone");
        expect(h.pipe.signal.reason).toBeInstanceOf(Error);
        expect((h.pipe.signal.reason as Error).message).toBe("gone");
      });
    });

    if (options.withMaxFrameBytes) {
      const build = () => options.withMaxFrameBytes?.(100) as Promise<MessagePipeHarness>;
      it("a message of exactly maxFrameBytes is sent; one byte past it ends the pipe with RangeError", () =>
        withHarness(build, async (h) => {
          h.pipe.target.postMessage(new Uint8Array(100));
          expect(h.pipe.signal.aborted).toBe(false);
          expect(() => h.pipe.target.postMessage(new Uint8Array(101))).toThrow(RangeError);
          expect(h.pipe.signal.aborted).toBe(true);
          expect(h.pipe.signal.reason).toBeInstanceOf(RangeError);
          await flush();
          expect((await h.sent()).map((b) => b.byteLength)).toEqual([100]);
        }));
    }

    it("whenDrained resolves at once on an idle pipe, and once the pipe ended", () =>
      withHarness(make, async (h) => {
        await h.pipe.target.whenDrained();
        await h.endRemotely();
        await h.pipe.target.whenDrained();
      }));

    it("a pending whenDrained resolves when the buffer drains to the low-water mark", () =>
      withHarness(make, async (h) => {
        if (!h.setBuffered) return;
        h.setBuffered(lowWater + 1);
        expect(h.pipe.target.bufferedAmount).toBe(lowWater + 1);
        let drained = false;
        const wait = h.pipe.target.whenDrained().then(() => {
          drained = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(drained).toBe(false);
        h.setBuffered(lowWater);
        await h.settle?.();
        await wait;
        expect(drained).toBe(true);
      }));

    it("a pending whenDrained resolves when the pipe ends", () =>
      withHarness(make, async (h) => {
        if (!h.setBuffered) return;
        h.setBuffered(lowWater + 1);
        const wait = h.pipe.target.whenDrained();
        await h.endRemotely();
        await wait;
      }));
  });
}
