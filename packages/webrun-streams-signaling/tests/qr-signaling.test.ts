import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCompressedSignal,
  decodeSignal,
  encodeSignal,
  parseCompressedSignal,
  QrSignaling,
} from "../src/qr-signaling.js";
import { readOne } from "./helpers.js";
import { makeMockRtc } from "./mocks/rtc.js";

describe("QrSignaling", () => {
  it("round-trips SDP + ICE through the compressed QR payload", () => {
    const description = {
      type: "offer" as const,
      sdp: [
        "v=0",
        "o=- token-xyz 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=ice-ufrag:token-xyz",
        "a=ice-pwd:secretsecretsecret",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      ].join("\r\n"),
    };
    const candidates = [
      {
        candidate: "candidate:1 1 udp 2113937151 127.0.0.1 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    ];

    const encoded = encodeSignal(
      createCompressedSignal("sess1", "initiator", description, candidates),
    );
    const parsed = parseCompressedSignal(decodeSignal(encoded));

    expect(parsed.sessionId).toBe("sess1");
    expect(parsed.role).toBe("initiator");
    expect(parsed.description.type).toBe("offer");
    expect(parsed.description.sdp).toContain("a=ice-ufrag:token-xyz");
    expect(parsed.description.sdp).toContain("o=- token-xyz");
    expect(parsed.candidates).toEqual(candidates);
  });

  it("(#146) keeps sdpMLineIndex 0 and the candidate attributes a connection needs", () => {
    const description = { type: "offer" as const, sdp: "v=0\r\no=- t 2 IN IP4 127.0.0.1" };
    const candidates = [
      {
        candidate:
          "candidate:2 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0 ufrag abcd",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      {
        candidate:
          "candidate:3 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.5 rport 61000 generation 0",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      { candidate: "garbage that does not parse", sdpMid: "0", sdpMLineIndex: 0 },
      { candidate: "garbage that does not parse", sdpMid: null, sdpMLineIndex: null },
    ];
    const parsed = parseCompressedSignal(
      decodeSignal(encodeSignal(createCompressedSignal("s", "initiator", description, candidates))),
    );
    expect(parsed.candidates).toEqual([
      {
        candidate: "candidate:2 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      {
        candidate:
          "candidate:3 1 udp 1686052607 203.0.113.7 61000 typ srflx raddr 192.168.1.5 rport 61000",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      { candidate: "garbage that does not parse", sdpMid: "0", sdpMLineIndex: 0 },
      { candidate: "garbage that does not parse", sdpMid: null, sdpMLineIndex: null },
    ]);
  });

  it("pairs two devices via offer/answer/accept and yields working ByteChannels", async () => {
    const rtc = makeMockRtc();
    const deviceA = new QrSignaling({ sessionId: "pair-1", connection: { rtc } });
    const deviceB = new QrSignaling({ sessionId: "pair-1", connection: { rtc } });

    const { qr: offerQr, accept } = await deviceA.offer();

    const decoded = decodeSignal(offerQr);
    expect(decoded.id).toBe("pair-1");
    expect(decoded.role).toBe("initiator");
    expect(decoded.ice.length).toBeGreaterThan(0);

    const { qr: answerQr, channel: chB } = await deviceB.answer(offerQr);
    expect(decodeSignal(answerQr).role).toBe("responder");

    const chA = await accept(answerQr);

    chA.send(new Uint8Array([7, 7, 7]));
    expect(await readOne(chB)).toEqual(new Uint8Array([7, 7, 7]));

    chB.send(new Uint8Array([42]));
    expect(await readOne(chA)).toEqual(new Uint8Array([42]));
  });

  describe("(#128) the connection timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not run while the people exchange QR codes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const rtc = makeMockRtc();
      const deviceA = new QrSignaling({ sessionId: "slow", connection: { rtc } });
      const deviceB = new QrSignaling({ sessionId: "slow", connection: { rtc } });

      const offered = deviceA.offer();
      await vi.advanceTimersByTimeAsync(100);
      const { qr: offerQr, accept } = await offered;
      // Two QR scans take longer than the 30 s connection timeout.
      await vi.advanceTimersByTimeAsync(45_000);
      vi.useRealTimers();

      const { qr: answerQr, channel: chB } = await deviceB.answer(offerQr);
      const chA = await accept(answerQr);
      chA.send(new Uint8Array([1]));
      expect(await readOne(chB)).toEqual(new Uint8Array([1]));
    });
  });
});
