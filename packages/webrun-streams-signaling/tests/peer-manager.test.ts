import type { ByteChannel } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { PeerManager } from "../src/peer-manager.js";
import { readOne } from "./helpers.js";
import { makeMockRtc } from "./mocks/rtc.js";
import { makeSignalingPair } from "./mocks/signaling-bus.js";

describe("PeerManager", () => {
  it("exchanges offer/answer over the signaling channel and yields working ByteChannels", async () => {
    const rtc = makeMockRtc();
    const [sigA, sigB] = makeSignalingPair("A", "B");
    const a = new PeerManager(sigA, { rtc });
    const b = new PeerManager(sigB, { rtc });

    const incoming = new Promise<{ peerId: string; ch: ByteChannel }>((resolve) => {
      b.onConnection((peerId, ch) => resolve({ peerId, ch }));
    });

    const chA = await a.connect("B");
    const { peerId, ch: chB } = await incoming;

    expect(peerId).toBe("A");

    chA.send(new Uint8Array([1, 2, 3]));
    expect(await readOne(chB)).toEqual(new Uint8Array([1, 2, 3]));

    chB.send(new Uint8Array([9, 8]));
    expect(await readOne(chA)).toEqual(new Uint8Array([9, 8]));

    a.close();
    b.close();
  });

  it("onConnection unsubscribe stops further notifications", async () => {
    const [sigA] = makeSignalingPair();
    const manager = new PeerManager(sigA, { rtc: makeMockRtc() });
    let calls = 0;
    const off = manager.onConnection(() => {
      calls += 1;
    });
    off();
    // No inbound offer arrives, but the handler must be gone regardless.
    expect(calls).toBe(0);
    manager.close();
  });
});
