import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { messageTargetOverByteChannel } from "../src/message-target.js";
import type { ByteChannel } from "../src/types.js";

/** A ByteChannel the test drives: what it injects arrives on `recv`. */
function fakeChannel() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const sent: Uint8Array[] = [];
  let buffered = 0;
  const drainWaiters = new Set<() => void>();
  const end = () => {
    if (done) return;
    done = true;
    wake?.();
    resolveClosed();
    for (const w of drainWaiters) w();
  };
  const channel: ByteChannel = {
    send: (bytes) => sent.push(bytes),
    recv: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift() as Uint8Array;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    })(),
    closed,
    close: end,
    get bufferedAmount() {
      return buffered;
    },
    whenDrained: () =>
      buffered <= 256 * 1024 ? Promise.resolve() : new Promise((r) => drainWaiters.add(r)),
  };
  return {
    channel,
    sent,
    end,
    inject: async (data: unknown) => {
      queue.push(data);
      wake?.();
      // The adapter reads `recv` asynchronously.
      await new Promise((r) => setTimeout(r, 0));
    },
    setBuffered: (n: number) => {
      buffered = n;
      if (n <= 256 * 1024) {
        for (const w of [...drainWaiters]) w();
        drainWaiters.clear();
      }
    },
  };
}

function harness(options?: { maxFrameBytes?: number }): MessagePipeHarness {
  const fake = fakeChannel();
  const pipe = messageTargetOverByteChannel(fake.channel, options);
  return {
    pipe,
    inject: fake.inject,
    sent: () => fake.sent,
    endRemotely: async () => {
      fake.end();
      await new Promise((r) => setTimeout(r, 0));
    },
    setBuffered: fake.setBuffered,
  };
}

describeMessagePipe("messageTargetOverByteChannel", () => harness(), {
  withMaxFrameBytes: (maxFrameBytes) => harness({ maxFrameBytes }),
});

import { expect, it } from "vitest";

it("(review of #181) a recv that throws still releases the channel", async () => {
  let closed = 0;
  const channel: ByteChannel = {
    send: () => {},
    recv: (async function* () {
      yield* [];
      throw new Error("recv broke");
    })(),
    closed: new Promise(() => {}),
    close: () => {
      closed++;
    },
  };
  const { signal } = messageTargetOverByteChannel(channel);
  await new Promise((r) => setTimeout(r, 10));
  expect(signal.aborted).toBe(true);
  expect((signal.reason as Error).message).toMatch(/recv broke/);
  expect(closed).toBe(1);
});
