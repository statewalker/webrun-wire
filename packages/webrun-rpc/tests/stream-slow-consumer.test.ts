import { afterEach, describe, expect, it, vi } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";
import { receive } from "../src/receive.js";
import { send } from "../src/send.js";

// statewalker/webrun-wire#138: the stream tier's chunk calls had the default
// 1 s `callPort` deadline, so a consumer slower than 1 s per item failed the
// stream. Only `setTimeout` is faked: port messages still travel for real, so
// the clock is advanced in small steps with a real macrotask between them.

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realTick = () => new Promise((r) => setImmediate(r));

async function runFor<T>(task: Promise<T>, virtualMs: number): Promise<T> {
  let settled = false;
  task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let t = 0; t < virtualMs && !settled; t += 50) {
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 5; i++) await realTick();
  }
  return task;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stream tier: a consumer slower than 1 s per item", () => {
  it("send / receive throttle a 1.5 s consumer instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port1, port2 } = newChannel();
    const got: number[] = [];
    const consume = (async () => {
      for await (const input of receive<number>(port2)) {
        for await (const v of input) {
          got.push(v);
          await sleep(1500);
        }
        break;
      }
    })();
    try {
      await runFor(Promise.all([send<number>(port1, [1, 2, 3]), consume]), 10_000);
      expect(got).toEqual([1, 2, 3]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("callBidi throttles a 1.5 s consumer instead of failing it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port1, port2 } = newChannel();
    const close = listenBidi<number, number>(port2, async function* (input) {
      for await (const v of input) yield v * 10;
    });
    const got: number[] = [];
    const consume = (async () => {
      for await (const v of callBidi<number, number>(port1, [1, 2, 3])) {
        got.push(v);
        await sleep(1500);
      }
    })();
    try {
      await runFor(consume, 10_000);
      expect(got).toEqual([10, 20, 30]);
    } finally {
      close();
      port1.close();
      port2.close();
    }
  });

  it("an explicit `timeout` still bounds each chunk call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port1, port2 } = newChannel();
    const consume = (async () => {
      for await (const input of receive<number>(port2)) {
        for await (const _v of input) await sleep(1500);
        break;
      }
    })();
    const sent = send<number>(port1, [1, 2], { timeout: 1000 });
    try {
      // The timed-out chunk call ends the stream with that error, which
      // reaches the consumer.
      await expect(runFor(consume, 5000)).rejects.toThrow(/Call timeout/);
      await runFor(sent, 1000);
    } finally {
      port1.close();
      port2.close();
    }
  });
});
