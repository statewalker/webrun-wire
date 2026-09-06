import { describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { callPort } from "../src/call-port.js";
import { ioHandle } from "../src/io-handle.js";
import { ioSend } from "../src/io-send.js";
import { listenBidi } from "../src/listen-bidi.js";
import { listenPort } from "../src/listen-port.js";
import type { MessageListener, MessageTarget } from "../src/message-target.js";
import { recieve } from "../src/recieve.js";
import { send } from "../src/send.js";

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

describe("callBidi / listenBidi over a plain MessageTarget", () => {
  it("roundtrips a stream with no MessagePort involved", async () => {
    const { a, b } = newTargetPair();
    const close = listenBidi<string, string>(b, async function* (input) {
      for await (const value of input) yield value.toUpperCase();
    });
    try {
      const values: string[] = [];
      for await (const v of callBidi<string, string>(a, ["hello", "world"])) {
        values.push(v);
      }
      expect(values).toEqual(["HELLO", "WORLD"]);
    } finally {
      close();
    }
  });
});

describe("ioSend / ioHandle over a plain MessageTarget", () => {
  it("exchanges an uppercased stream with no MessagePort involved", async () => {
    const { a, b } = newTargetPair();
    const options = { channelName: "test" };
    const controller = new AbortController();
    try {
      void (async () => {
        async function* handler(input: AsyncIterable<string>) {
          for await (const value of input) yield value.toUpperCase();
        }
        for await (const callId of ioHandle<string, string>(b, handler, options)) {
          if (controller.signal.aborted) break;
          void callId;
        }
      })();

      const values: string[] = [];
      for await (const value of ioSend<string, string>(a, ["x", "y"], options)) {
        values.push(value);
      }
      expect(values).toEqual(["X", "Y"]);
    } finally {
      controller.abort();
    }
  });
});

describe("send / recieve over a plain MessageTarget", () => {
  it("transports values with no MessagePort involved", async () => {
    const { a, b } = newTargetPair();
    void send<number>(b, [1, 2, 3], { channelName: "" });

    const values: number[] = [];
    for await (const input of recieve<number>(a, { channelName: "" })) {
      for await (const value of input) values.push(value);
      break;
    }
    expect(values).toEqual([1, 2, 3]);
  });
});
