import { describe, expect, it } from "vitest";
import { connect } from "../src/connect-serve.js";

/** an `RTCPeerConnection` stand-in that only counts its event listeners */
function countingPc() {
  const listeners = new Map<string, Set<unknown>>();
  const pc = {
    connectionState: "connected",
    addEventListener(type: string, fn: unknown) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: unknown) {
      listeners.get(type)?.delete(fn);
    },
  };
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { pc: pc as unknown as RTCPeerConnection, count };
}

describe("webrun-streams-webrtc — connect() listeners", () => {
  it("close() removes the listener connect() added to the peer connection", async () => {
    const { pc, count } = countingPc();
    const conns = await Promise.all(Array.from({ length: 5 }, () => connect({ pc })));
    expect(count()).toBe(5);
    for (const c of conns) await c.close();
    expect(count()).toBe(0);
  });
});
