import { describe, expect, it } from "vitest";
import { callPort } from "../src/call-port.js";
import { listenPort } from "../src/listen-port.js";
import type { MessageListener, MessageTarget } from "../src/message-target.js";

/**
 * A MessageTarget that is emphatically not a MessagePort: two plain objects
 * wired to each other. Before this task the RPC tier could not accept one.
 */
function newTargetPair(): { a: MessageTarget; b: MessageTarget } {
  const listeners = { a: new Set<MessageListener>(), b: new Set<MessageListener>() };
  const make = (self: "a" | "b", peer: "a" | "b"): MessageTarget => ({
    addEventListener(_type, listener) {
      listeners[self].add(listener);
    },
    removeEventListener(_type, listener) {
      listeners[self].delete(listener);
    },
    postMessage(message) {
      // Deliver on a later task, matching MessagePort's asynchrony.
      setTimeout(() => {
        for (const listener of [...listeners[peer]]) {
          void listener(new MessageEvent("message", { data: message }));
        }
      }, 0);
    },
  });
  return { a: make("a", "b"), b: make("b", "a") };
}

describe("the RPC tier over a plain MessageTarget", () => {
  it("completes a request/response round trip with no MessagePort involved", async () => {
    const { a, b } = newTargetPair();
    const off = listenPort(b, async (params) => ({ echoed: params }));
    try {
      const result = await callPort(a, { hello: "world" }, { timeout: 2000 });
      expect(result).toEqual({ echoed: { hello: "world" } });
    } finally {
      off();
    }
  });
});
