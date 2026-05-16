import { describe, expect, it } from "vitest";
import { callPort } from "../src/call-port.js";
import { listenPort } from "../src/listen-port.js";

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

describe("callPort / listenPort", () => {
  it("performs a round-trip request/response", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async (params) => params);
    try {
      const res = await callPort(port2, { foo: "bar" });
      expect(res).toEqual({ foo: "bar" });
    } finally {
      close();
    }
  });

  it("rejects when the handler exceeds the timeout", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async (params) => {
      await new Promise((r) => setTimeout(r, 500));
      return params;
    });
    try {
      await expect(callPort(port2, {}, { timeout: 100 })).rejects.toThrow(/Call timeout/);
    } finally {
      close();
    }
  });

  it("propagates the thrown error to the caller", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async () => {
      throw new Error("server exploded");
    });
    try {
      await expect(callPort(port2, {})).rejects.toThrow("server exploded");
    } finally {
      close();
    }
  });

  it("honours the channelName filter", async () => {
    const { port1, port2 } = newChannel();
    const closeA = listenPort(port1, async () => "A", { channelName: "a" });
    const closeB = listenPort(port1, async () => "B", { channelName: "b" });
    try {
      expect(await callPort(port2, {}, { channelName: "a" })).toBe("A");
      expect(await callPort(port2, {}, { channelName: "b" })).toBe("B");
    } finally {
      closeA();
      closeB();
    }
  });

  it("ignores messages whose channelName does not match", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async () => "wrong", { channelName: "other" });
    try {
      // No listener on the default channel — caller times out quickly.
      await expect(callPort(port2, {}, { timeout: 50 })).rejects.toThrow(/Call timeout/);
    } finally {
      close();
    }
  });

  it("cleanup removes the listener so later calls time out", async () => {
    const { port1, port2 } = newChannel();
    const close = listenPort(port1, async () => "ok");
    expect(await callPort(port2, {})).toBe("ok");
    close();
    await expect(callPort(port2, {}, { timeout: 50 })).rejects.toThrow(/Call timeout/);
  });
});
