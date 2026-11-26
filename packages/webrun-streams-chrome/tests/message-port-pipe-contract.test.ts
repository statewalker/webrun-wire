import { viewBytes } from "@statewalker/webrun-streams";
import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import { messagePortPipe, PIPE_CLOSED } from "../src/index.js";

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

function channel(): MessageChannel {
  const c = new MessageChannel();
  channels.push(c);
  return c;
}

/** The pipe on `port1`; `port2` stands for the peer, recording what arrives. */
function harness(): MessagePipeHarness {
  const { port1, port2 } = channel();
  const pipe = messagePortPipe(port1);
  const received: unknown[] = [];
  port2.addEventListener("message", (e) => {
    received.push(e.data);
  });
  port2.start();
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return {
    pipe,
    inject: async (data) => {
      port2.postMessage(data);
      await settle();
    },
    sent: async () => {
      await settle();
      return received.flatMap((data) => {
        const bytes = viewBytes(data);
        return bytes ? [bytes] : [];
      });
    },
    endRemotely: async () => {
      port2.postMessage({ type: PIPE_CLOSED, reason: "the peer went away" });
      await settle();
    },
  };
}

describeMessagePipe("messagePortPipe", () => harness());

describe("messagePortPipe", () => {
  it("a local close tells the peer, which ends with the reason given", async () => {
    const { port1, port2 } = channel();
    const left = messagePortPipe(port1);
    const right = messagePortPipe(port2, { name: "page<->cs" });
    await left.target.close(new Error("cs<->sw: the chrome.runtime.Port disconnected"));
    await expect.poll(() => right.signal.aborted).toBe(true);
    expect((right.signal.reason as Error).message).toBe(
      "page<->cs: the peer closed: cs<->sw: the chrome.runtime.Port disconnected",
    );
  });

  it("sends a copy and transfers its buffer: the caller's bytes stay usable", async () => {
    const { port1, port2 } = channel();
    const left = messagePortPipe(port1);
    const right = messagePortPipe(port2);
    const got: Uint8Array[] = [];
    right.target.addEventListener("message", (e) => {
      got.push(e.data as Uint8Array);
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    left.target.postMessage(bytes.subarray(1, 3));
    left.target.postMessage(bytes);
    expect(bytes.byteLength).toBe(4);
    await expect.poll(() => got.length).toBe(2);
    expect([...(got[0] as Uint8Array)]).toEqual([2, 3]);
    expect([...(got[1] as Uint8Array)]).toEqual([1, 2, 3, 4]);
    await left.target.close();
  });
});
