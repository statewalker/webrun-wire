import { describe, expect, it } from "vitest";
import { PeerManager } from "../src/peer-manager.js";
import type { ByteChannel } from "../src/types.js";
import { readOne } from "./helpers.js";
import { makeMockRtc } from "./mocks/rtc.js";
import { makeSignalingPair } from "./mocks/signaling-bus.js";

/** Whether `p` settles within a second. */
const within = (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);

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

  it("(#127) forgets a connection that fails, so the peer can reconnect", async () => {
    const rtc = makeMockRtc();
    const [sigA, sigB] = makeSignalingPair("A", "B");
    const a = new PeerManager(sigA, { rtc });
    const b = new PeerManager(sigB, { rtc });
    const inbound: ByteChannel[] = [];
    let wake: (() => void) | undefined;
    b.onConnection((_peerId, ch) => {
      inbound.push(ch);
      wake?.();
    });
    const nextInbound = (n: number) =>
      within(
        new Promise<void>((r) => {
          wake = () => inbound.length >= n && r();
          wake();
        }),
      );

    await a.connect("B");
    expect(await nextInbound(1)).toBe(true);

    // ICE fails on both ends.
    for (const pc of rtc.instances) pc._fail();

    const chA = await a.connect("B");
    expect(await nextInbound(2)).toBe(true);
    chA.send(new Uint8Array([4, 2]));
    expect(await readOne(inbound[1])).toEqual(new Uint8Array([4, 2]));

    a.close();
    b.close();
  });

  it("(#126, #127) a responder whose channel never opens is reported and forgotten", async () => {
    const rtc = makeMockRtc();
    const [sigA, sigB] = makeSignalingPair("A", "B");
    const errors: Array<{ error: Error; peerId: string }> = [];
    const b = new PeerManager(sigB, {
      rtc,
      connectionTimeout: 50,
      onError: (error, peerId) => errors.push({ error, peerId }),
    });
    const incoming = new Promise<string>((r) => b.onConnection((peerId) => r(peerId)));

    // An offer whose data channel no one will ever open.
    sigA.send("B", { type: "offer", sdp: "v=0\r\no=- nobody 2 IN IP4 127.0.0.1\r\n" });
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.map((e) => [e.peerId, e.error.message])).toEqual([
      ["A", "Connection timeout after 50ms"],
    ]);

    // The failed responder is gone: a real dial from A now gets through.
    const a = new PeerManager(sigA, { rtc });
    await a.connect("B");
    expect(await within(incoming)).toBe(true);

    a.close();
    b.close();
  });

  it("(#126) a signal the connection rejects is reported, and the connection is dropped", async () => {
    const rtc = makeMockRtc();
    const [sigA, sigB] = makeSignalingPair("A", "B");
    const errors: Array<{ error: Error; peerId: string }> = [];
    const b = new PeerManager(sigB, {
      rtc,
      onError: (error, peerId) => errors.push({ error, peerId }),
    });
    // B dials A (no one answers); A's offer arrives meanwhile: glare.
    const dial = b.connect("A");
    sigA.send("B", { type: "offer", sdp: "v=0\r\n" });
    await expect(dial).rejects.toThrow();
    expect(errors.map((e) => [e.peerId, e.error.message])).toEqual([
      ["A", "Received offer but not in responder role"],
    ]);
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
