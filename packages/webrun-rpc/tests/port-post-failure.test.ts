import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callPort, NO_TIMEOUT } from "../src/call-port.js";
import { listenPort } from "../src/listen-port.js";
import type { MessageTarget } from "../src/message-target.js";

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

// Records unhandled rejections raised while a test runs.
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

const settle = () => new Promise((r) => setTimeout(r, 20));

// statewalker/webrun-wire#137
describe("listenPort: a reply that cannot be posted", () => {
  it("answers an unclonable result with response:error instead of leaving the caller waiting", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async () => ({ f: () => 1 }));
    try {
      await expect(callPort(port2, {}, { timeout: NO_TIMEOUT })).rejects.toThrow(
        /could not be cloned/,
      );
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      close();
      port1.close();
      port2.close();
    }
  });

  it("answers an error carrying an unclonable field with its message", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async () => {
      throw Object.assign(new Error("server exploded"), { handle: () => 1 });
    });
    try {
      await expect(callPort(port2, {}, { timeout: NO_TIMEOUT })).rejects.toThrow(
        /server exploded|could not be cloned/,
      );
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      close();
      port1.close();
      port2.close();
    }
  });

  it("raises no unhandled rejection when every post fails", async () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    let posts = 0;
    const port: MessageTarget = {
      addEventListener: (_t, l) => listeners.add(l as (e: MessageEvent) => void),
      removeEventListener: (_t, l) => listeners.delete(l as (e: MessageEvent) => void),
      postMessage: () => {
        posts++;
        throw new Error("transport gone");
      },
    };
    const close = listenPort(port, async (p) => p);
    try {
      for (const l of listeners) {
        l(new MessageEvent("message", { data: { type: "request", channelName: "", callId: "1" } }));
      }
      await settle();
      expect(posts).toBe(2); // the result, then the error reply
      expect(unhandled).toEqual([]);
    } finally {
      close();
    }
  });
});

// statewalker/webrun-wire#149, bullet 2
describe("callPort: a request that cannot be posted", () => {
  it("rejects and removes its listeners when postMessage throws synchronously", async () => {
    const listeners = new Set<unknown>();
    const port: MessageTarget = {
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
      postMessage: () => {
        throw new Error("DataCloneError");
      },
    };
    const abort = new AbortController();
    let abortListeners = 0;
    const add = abort.signal.addEventListener.bind(abort.signal);
    const remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      abortListeners++;
      add(...args);
    }) as typeof add;
    abort.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      abortListeners--;
      remove(...args);
    }) as typeof remove;

    const call = callPort(port, {}, { timeout: NO_TIMEOUT, signal: abort.signal });
    await expect(call).rejects.toThrow(/DataCloneError/);
    await settle();
    expect(listeners.size).toBe(0);
    expect(abortListeners).toBe(0);
  });
});
