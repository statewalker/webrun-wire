import { describe, expect, it } from "vitest";
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
});
