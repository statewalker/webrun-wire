import { describe, expect, it } from "vitest";
import { handleStreams, sendStream } from "../src/core/data-channels.js";
import type { MessageTarget } from "../src/core/message-target.js";

function asTarget(port: MessagePort): MessageTarget {
  return port as unknown as MessageTarget;
}

describe("sendStream / handleStreams", () => {
  it("roundtrips an async iterator through a MessageChannel", async () => {
    const { port1, port2 } = new MessageChannel();
    const cleanup = handleStreams<number>(asTarget(port1), async function* (input) {
      for await (const n of input) yield n * 2;
    });
    try {
      async function* source() {
        yield 1;
        yield 2;
        yield 3;
      }
      const out: number[] = [];
      for await (const v of sendStream<number>(asTarget(port2), source())) out.push(v);
      expect(out).toEqual([2, 4, 6]);
    } finally {
      cleanup();
      port1.close();
      port2.close();
    }
  });

  it("passes params to the stream handler", async () => {
    const { port1, port2 } = new MessageChannel();
    let seenParams: Record<string, unknown> | undefined;
    const cleanup = handleStreams<string>(asTarget(port1), async function* (_input, params) {
      seenParams = params;
      yield "ok";
    });
    try {
      async function* nothing() {}
      const out: string[] = [];
      for await (const v of sendStream<string>(asTarget(port2), nothing(), { tag: "abc" })) {
        out.push(v);
      }
      expect(out).toEqual(["ok"]);
      expect(seenParams).toEqual({ tag: "abc" });
    } finally {
      cleanup();
      port1.close();
      port2.close();
    }
  });

  // A handler that fails before it returns a stream must reach the caller as
  // that error, not as an empty stream plus an unhandled rejection here.
  it("delivers a handler's failure to the caller", async () => {
    const { port1, port2 } = new MessageChannel();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const cleanup = handleStreams<string>(asTarget(port1), async () => {
      throw new Error("boom");
    });
    try {
      async function* nothing() {}
      const read = async () => {
        const out: string[] = [];
        for await (const v of sendStream<string>(asTarget(port2), nothing())) out.push(v);
        return out;
      };
      await expect(read()).rejects.toThrow("boom");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      cleanup();
      port1.close();
      port2.close();
    }
  });
});

describe("misspelt names", () => {
  it("newInvocationChannel is exported, and the misspelt alias newInvokationChannel is gone (#150)", async () => {
    const lib = (await import("../src/index.js")) as Record<string, unknown>;
    expect(typeof lib.newInvocationChannel).toBe("function");
    expect(lib).not.toHaveProperty("newInvokationChannel");
  });
});
