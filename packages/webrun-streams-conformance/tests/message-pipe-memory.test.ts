import { newMessagePipe } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { describeMessagePipe, type MessagePipeHarness } from "../src/index.js";

/**
 * The pipe module over an in-memory transport: the contract at the module's
 * own interface, with no real transport in the way (statewalker/webrun-wire#151).
 */
function memoryHarness(
  options: { maxFrameBytes?: number; nativeDrain?: boolean } = {},
): MessagePipeHarness {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  const waiters = new Set<() => void>();
  const control = newMessagePipe(
    {
      send: (bytes) => sent.push(bytes),
      bufferedAmount: () => buffered,
      ...(options.nativeDrain
        ? {
            whenDrained: () => new Promise<void>((resolve) => waiters.add(resolve)),
          }
        : {}),
    },
    {
      name: "memory",
      maxFrameBytes: options.maxFrameBytes,
      maxMessageSize: 1000,
      copyOnSend: true,
    },
  );
  return {
    pipe: control.pipe,
    inject: (data) => control.deliver(data),
    sent: () => sent,
    endRemotely: () => control.end(new Error("memory: the peer went away")),
    setBuffered: (n) => {
      buffered = n;
      if (n <= 256 * 1024) {
        for (const w of [...waiters]) w();
        waiters.clear();
      }
    },
  };
}

describeMessagePipe("newMessagePipe (polled drain)", () => memoryHarness(), {
  withMaxFrameBytes: (maxFrameBytes) => memoryHarness({ maxFrameBytes }),
});
describeMessagePipe("newMessagePipe (native drain)", () => memoryHarness({ nativeDrain: true }));

describe("newMessagePipe specifics", () => {
  it("an inbound message that is not bytes ends the pipe with TypeError, and closes the transport as local", async () => {
    const closes: boolean[] = [];
    const control = newMessagePipe(
      { send: () => {}, close: (local) => void closes.push(local) },
      { name: "memory" },
    );
    control.deliver({ not: "bytes" });
    expect(control.pipe.signal.reason).toBeInstanceOf(TypeError);
    expect(closes).toEqual([true]);
  });

  it("textAsBytes delivers a string as its UTF-8 bytes", () => {
    const control = newMessagePipe({ send: () => {} }, { name: "memory", textAsBytes: true });
    const got: number[][] = [];
    control.pipe.target.addEventListener("message", (e) => {
      got.push([...(e.data as Uint8Array)]);
    });
    control.deliver("hé");
    expect(got).toEqual([[0x68, 0xc3, 0xa9]]);
  });

  it("copyOnDeliver and copyOnSend copy; without them the bytes are the same view", () => {
    const sent: Uint8Array[] = [];
    const copying = newMessagePipe(
      { send: (b) => sent.push(b) },
      { name: "memory", copyOnSend: true, copyOnDeliver: true },
    );
    const got: Uint8Array[] = [];
    copying.pipe.target.addEventListener("message", (e) => {
      got.push(e.data as Uint8Array);
    });
    const shared = new Uint8Array([1, 2]);
    copying.deliver(shared);
    copying.pipe.target.postMessage(shared);
    shared[0] = 9;
    expect([...(got[0] as Uint8Array)]).toEqual([1, 2]);
    expect([...(sent[0] as Uint8Array)]).toEqual([1, 2]);

    const plain = newMessagePipe({ send: (b) => sent.push(b) }, { name: "memory" });
    plain.pipe.target.postMessage(shared);
    expect(sent[1]).toBe(shared);
  });

  it("the transport is closed once, as remote when it reported the end", async () => {
    const closes: boolean[] = [];
    const control = newMessagePipe(
      { send: () => {}, close: (local) => void closes.push(local) },
      { name: "memory" },
    );
    control.end(new Error("gone"));
    await control.pipe.target.close();
    control.end(new Error("again"));
    expect(closes).toEqual([false]);
  });

  it("close() lets the transport flush before it ends the pipe", async () => {
    const order: string[] = [];
    const control = newMessagePipe(
      {
        send: () => {},
        flush: async () => {
          order.push(`flush, aborted=${control.ended}`);
        },
        close: () => void order.push("close"),
      },
      { name: "memory" },
    );
    await control.pipe.target.close();
    expect(order).toEqual(["flush, aborted=false", "close"]);
  });

  it("canSend false makes a post a no-op", () => {
    const sent: Uint8Array[] = [];
    let open = false;
    const control = newMessagePipe(
      { send: (b) => sent.push(b), canSend: () => open },
      { name: "memory" },
    );
    control.pipe.target.postMessage(new Uint8Array([1]));
    open = true;
    control.pipe.target.postMessage(new Uint8Array([2]));
    expect(sent.map((b) => [...b])).toEqual([[2]]);
  });
});
