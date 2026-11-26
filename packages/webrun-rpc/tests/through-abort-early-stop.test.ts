import { describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";
import type { MessageTarget } from "../src/message-target.js";
import { throughAbort } from "../src/through-abort.js";

/** A `MessageChannel` half that carries a close signal, as a transport-backed port does. */
function closablePort(port: MessagePort, signal: AbortSignal): MessageTarget {
  port.start();
  return {
    addEventListener: (type, listener) => port.addEventListener(type, listener),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener),
    postMessage: (message, transfer) => port.postMessage(message, transfer ?? []),
    closeSignal: signal,
  };
}

async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("throughAbort when its consumer stops early (statewalker/webrun-wire#216)", () => {
  it("returns the source when the consumer stops without an abort", async () => {
    let finallyRan = false;
    const source = (async function* () {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        finallyRan = true;
      }
    })();
    const signal = new AbortController().signal;
    for await (const v of throughAbort(source, signal)) {
      if (v === 2) break;
    }
    await waitFor(() => finallyRan);
    expect(finallyRan).toBe(true);
  });

  it("returns the source when the consumer throws", async () => {
    let finallyRan = false;
    const source = (async function* () {
      try {
        for (let i = 0; ; i++) yield i;
      } finally {
        finallyRan = true;
      }
    })();
    await expect(
      (async () => {
        for await (const _ of throughAbort(source, new AbortController().signal)) {
          throw new Error("consumer failed");
        }
      })(),
    ).rejects.toThrow("consumer failed");
    await waitFor(() => finallyRan);
  });

  it("does not return a source that finished or threw", async () => {
    let returns = 0;
    const make = (fail: boolean): AsyncIterable<number> => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async () => {
            if (i < 2) return { done: false, value: i++ };
            if (fail) throw new Error("source failed");
            return { done: true, value: undefined };
          },
          return: async () => {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    });
    const out: number[] = [];
    for await (const v of throughAbort(make(false), new AbortController().signal)) out.push(v);
    expect(out).toEqual([0, 1]);
    await expect(
      (async () => {
        for await (const _ of throughAbort(make(true), new AbortController().signal)) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("source failed");
    expect(returns).toBe(0);
  });

  it("returns the source once on an abort", async () => {
    let returns = 0;
    let pulls = 0;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: pulls++ }),
          return: async () => {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const out: number[] = [];
    for await (const v of throughAbort(source, controller.signal)) {
      out.push(v);
      if (v === 1) controller.abort();
    }
    expect(out).toEqual([0, 1]);
    expect(returns).toBe(1);
  });

  it("a listenBidi producer whose port closes under a pending chunk send runs its finally", async () => {
    const channel = new MessageChannel();
    const serverClosed = new AbortController();
    const server = closablePort(channel.port1, serverClosed.signal);
    const client = closablePort(channel.port2, new AbortController().signal);

    let yielded = 0;
    let producerFinally = false;
    const stop = listenBidi<undefined, number>(server, async function* events() {
      try {
        for (let i = 0; ; i++) {
          yielded = i + 1;
          yield i;
        }
      } finally {
        producerFinally = true;
      }
    });

    try {
      // Take one value and then stop pulling without returning: the reply to
      // a chunk is withheld until the consumer pulls past it, so the server's
      // chunk send stays pending.
      const iter = callBidi<undefined, number>(client, [])[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value).toBe(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(yielded).toBeGreaterThanOrEqual(1);
      expect(producerFinally).toBe(false);

      // The server's transport goes away: the pending chunk call rejects.
      serverClosed.abort(new Error("port closed"));
      await waitFor(() => producerFinally, 1000);
      expect(producerFinally).toBe(true);
    } finally {
      stop();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
