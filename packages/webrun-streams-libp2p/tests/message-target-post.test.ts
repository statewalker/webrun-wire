import type { Libp2p } from "@libp2p/interface";
import { afterEach, describe, expect, it } from "vitest";
import { messageTargetOverStream } from "../src/message-target-over-stream.js";
import { createNode } from "./make-libp2p-pair.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function node(): Promise<Libp2p> {
  const n = await createNode();
  cleanups.push(() => n.stop());
  return n;
}

describe("messageTargetOverStream — postMessage", () => {
  it("throws TypeError for anything but bytes, and sends ArrayBuffer and views as bytes", async () => {
    const serverNode = await node();
    const received: Uint8Array[] = [];
    await serverNode.handle("/test-post/1.0.0", (stream) => {
      const { target } = messageTargetOverStream(stream);
      target.addEventListener("message", (ev) => {
        received.push(ev.data as Uint8Array);
      });
    });
    const addr = serverNode.getMultiaddrs()[0];
    if (!addr) throw new Error("no listen address");
    const stream = await (await node()).dialProtocol(addr, ["/test-post/1.0.0"]);
    const { target } = messageTargetOverStream(stream);
    for (const bad of ["text", 42, { a: 1 }, null, undefined]) {
      expect(() => target.postMessage(bad)).toThrow(TypeError);
    }
    target.postMessage(new Uint8Array([1, 2]));
    target.postMessage(new Uint8Array([3, 4]).buffer);
    target.postMessage(new DataView(new Uint8Array([9, 5, 6]).buffer, 1, 2));
    const deadline = Date.now() + 2000;
    while (received.length < 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(received.map((m) => [...m])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });
});
