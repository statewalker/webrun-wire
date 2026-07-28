/**
 * QR code signaling for serverless WebRTC connection.
 *
 * Relocated from `@statewalker/vcs-port-webrtc`'s `signaling.ts` (neutralised).
 * Compresses WebRTC signaling data (SDP + ICE candidates) into a compact,
 * base64 form suitable for QR codes, enabling out-of-band manual pairing where
 * peers exchange QR strings instead of using a live signaling server.
 *
 * The compress/expand/encode/decode functions are pure and unchanged; the
 * {@link QrSignaling} class is adapted to the target API and yields
 * webrun-streams {@link ByteChannel}s.
 */

import type { ByteChannel } from "@statewalker/webrun-streams";
import { PeerConnection } from "./peer-connection.js";
import type {
  CompressedSignal,
  IceCandidate,
  PeerRole,
  SessionDescription,
  WebRtcConnectionOptions,
} from "./types.js";

/** Current protocol version */
const PROTOCOL_VERSION = 1;

/** Generate a short random session ID. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Compress SDP by keeping only the essential lines. */
function compressSdp(sdp: string): string {
  const lines = sdp.split("\r\n");
  const essential: string[] = [];
  for (const line of lines) {
    if (
      line.startsWith("v=") ||
      line.startsWith("o=") ||
      line.startsWith("s=") ||
      line.startsWith("t=") ||
      line.startsWith("a=group:") ||
      line.startsWith("a=ice-ufrag:") ||
      line.startsWith("a=ice-pwd:") ||
      line.startsWith("a=fingerprint:") ||
      line.startsWith("a=setup:") ||
      line.startsWith("m=") ||
      line.startsWith("c=") ||
      line.startsWith("a=mid:") ||
      line.startsWith("a=sctp-port:") ||
      line.startsWith("a=max-message-size:")
    ) {
      essential.push(line);
    }
  }
  return essential.join("\n");
}

/** Expand compressed SDP back to a valid (CRLF) form. */
function expandSdp(compressed: string): string {
  const lines = compressed.split("\n");
  return `${lines.join("\r\n")}\r\n`;
}

/** Compress an ICE candidate to its essential parts. */
function compressCandidate(candidate: IceCandidate): string {
  const { candidate: c, sdpMid, sdpMLineIndex } = candidate;
  const match = c.match(/candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)/);
  if (!match) {
    return `R:${sdpMid ?? ""}:${sdpMLineIndex ?? 0}:${c}`;
  }
  const [, foundation, component, protocol, priority, ip, port, type] = match;
  return `${foundation}|${component}|${protocol}|${priority}|${ip}|${port}|${type}|${sdpMid ?? ""}|${sdpMLineIndex ?? 0}`;
}

/** Expand a compressed ICE candidate. */
function expandCandidate(compressed: string): IceCandidate {
  if (compressed.startsWith("R:")) {
    const [, sdpMid, sdpMLineIndexStr, ...rest] = compressed.split(":");
    return {
      candidate: rest.join(":"),
      sdpMid: sdpMid || null,
      sdpMLineIndex: Number.parseInt(sdpMLineIndexStr, 10) || null,
    };
  }
  const parts = compressed.split("|");
  if (parts.length < 9) {
    throw new Error(`Invalid compressed candidate: ${compressed}`);
  }
  const [foundation, component, protocol, priority, ip, port, type, sdpMid, sdpMLineIndexStr] =
    parts;
  const candidate = `candidate:${foundation} ${component} ${protocol} ${priority} ${ip} ${port} typ ${type}`;
  return {
    candidate,
    sdpMid: sdpMid || null,
    sdpMLineIndex: sdpMLineIndexStr ? Number.parseInt(sdpMLineIndexStr, 10) : null,
  };
}

/** Create a compressed signal for QR code exchange. */
export function createCompressedSignal(
  sessionId: string,
  role: PeerRole,
  description: SessionDescription,
  candidates: IceCandidate[],
): CompressedSignal {
  return {
    v: PROTOCOL_VERSION,
    id: sessionId,
    role,
    sdp: compressSdp(description.sdp),
    ice: candidates.map(compressCandidate),
  };
}

/** Parse a compressed signal. */
export function parseCompressedSignal(signal: CompressedSignal): {
  sessionId: string;
  role: PeerRole;
  description: SessionDescription;
  candidates: IceCandidate[];
} {
  if (signal.v !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${signal.v}`);
  }
  const type = signal.role === "initiator" ? "offer" : "answer";
  return {
    sessionId: signal.id,
    role: signal.role,
    description: { type, sdp: expandSdp(signal.sdp) },
    candidates: signal.ice.map(expandCandidate),
  };
}

/** Encode a compressed signal to a URL-safe base64 string for a QR code. */
export function encodeSignal(signal: CompressedSignal): string {
  const json = JSON.stringify(signal);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Decode a signal string from a QR code. */
export function decodeSignal(encoded: string): CompressedSignal {
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return JSON.parse(atob(base64));
}

/** Options for {@link QrSignaling}. */
export interface QrSignalingOptions {
  sessionId?: string;
  connection?: WebRtcConnectionOptions;
}

/**
 * Serverless WebRTC pairing over QR codes.
 *
 * Flow:
 *  1. Initiator `offer()` → `{ qr, accept }`; displays `qr`.
 *  2. Responder `answer(offerQr)` → `{ qr, channel }`; displays its `qr`.
 *  3. Initiator `accept(answerQr)` → `channel`. Both ends now hold a working
 *     {@link ByteChannel}.
 */
export class QrSignaling {
  private readonly sessionId: string;
  private readonly connection: WebRtcConnectionOptions;

  constructor(options: QrSignalingOptions = {}) {
    this.sessionId = options.sessionId ?? generateSessionId();
    this.connection = options.connection ?? {};
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Create an offer QR; `accept(answerQr)` finishes the handshake. */
  async offer(): Promise<{ qr: string; accept(answerQr: string): Promise<ByteChannel> }> {
    const pc = new PeerConnection("initiator", this.connection);
    const channel = pc.open();
    await pc.connect();
    await pc.waitForIceGathering();

    const description = pc.getLocalDescription();
    if (!description) throw new Error("No local description after offer");
    const qr = encodeSignal(
      createCompressedSignal(this.sessionId, "initiator", description, pc.getCollectedCandidates()),
    );

    return {
      qr,
      accept: async (answerQr: string): Promise<ByteChannel> => {
        const parsed = parseCompressedSignal(decodeSignal(answerQr));
        await pc.handleSignal({ type: "answer", sdp: parsed.description.sdp });
        for (const candidate of parsed.candidates) {
          await pc.handleSignal({ type: "candidate", candidate });
        }
        return channel;
      },
    };
  }

  /** Consume an offer QR and produce an answer QR + the established channel. */
  async answer(offerQr: string): Promise<{ qr: string; channel: ByteChannel }> {
    const parsed = parseCompressedSignal(decodeSignal(offerQr));
    const pc = new PeerConnection("responder", this.connection);
    const channel = pc.open();

    await pc.handleSignal({ type: "offer", sdp: parsed.description.sdp });
    for (const candidate of parsed.candidates) {
      await pc.handleSignal({ type: "candidate", candidate });
    }
    await pc.waitForIceGathering();

    const description = pc.getLocalDescription();
    if (!description) throw new Error("No local description after answer");
    const qr = encodeSignal(
      createCompressedSignal(parsed.sessionId, "responder", description, pc.getCollectedCandidates()),
    );

    return { qr, channel: await channel };
  }
}
