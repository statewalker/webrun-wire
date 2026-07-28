/**
 * Mock WebRTC stack: a `RtcPeerConnectionFactory` that drives the *real*
 * PeerConnection routing/offer-answer state machine without a browser or
 * network. Two mock connections created by the same factory share a rendezvous
 * map, so the data channels they negotiate are wired to each other over a real
 * in-process `MessageChannel` — giving working byte flow for the tests.
 */

import type { RtcPeerConnectionFactory } from "../../src/types.js";

let tokenCounter = 0;

const MOCK_CANDIDATE = "candidate:1 1 udp 2113937151 127.0.0.1 54321 typ host";

/** Minimal, valid-ish SDP carrying `token` in the `o=` line (survives QR compression). */
function mockSdp(token: string): string {
  return [
    "v=0",
    `o=- ${token} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${token}`,
    "a=ice-pwd:mockmockmockmockmockmock",
    "a=fingerprint:sha-256 AA:BB:CC:DD",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ].join("\r\n");
}

function parseToken(sdp: string): string | null {
  const match = sdp.match(/o=-\s+(\S+)/);
  return match ? match[1] : null;
}

class MockDataChannel {
  binaryType = "arraybuffer";
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(
    private readonly port: MessagePort,
    public readonly label = "webrun-data",
  ) {
    this.port.onmessage = (e: MessageEvent) => this.dispatch("message", e);
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  private dispatch(type: string, e: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }

  send(data: unknown): void {
    this.port.postMessage(data);
  }

  _open(): void {
    this.readyState = "open";
    this.port.start?.();
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    this.dispatch("close", {});
    try {
      this.port.close();
    } catch {
      /* ignore */
    }
  }
}

class MockPeerConnection {
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: unknown }) => void) | null = null;
  iceGatheringState: "new" | "gathering" | "complete" = "new";
  connectionState: "new" | "connected" | "closed" = "new";
  localDescription: { type: string; sdp: string } | null = null;

  private localSet = false;
  private remoteSet = false;
  private gathered = false;
  private connected = false;
  private remoteToken: string | null = null;
  private localDc: MockDataChannel | null = null;
  private readonly token = `mock-${++tokenCounter}`;

  constructor(private readonly rendezvous: Map<string, MessagePort>) {}

  createDataChannel(label: string): MockDataChannel {
    const mc = new MessageChannel();
    this.rendezvous.set(this.token, mc.port2);
    this.localDc = new MockDataChannel(mc.port1, label);
    return this.localDc;
  }

  createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return Promise.resolve({ type: "offer", sdp: mockSdp(this.token) });
  }

  createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    return Promise.resolve({ type: "answer", sdp: mockSdp(this.token) });
  }

  setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.localDescription = { type: desc.type, sdp: desc.sdp };
    this.localSet = true;
    this.scheduleGather();
    this.maybeConnect();
    return Promise.resolve();
  }

  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteToken = parseToken(desc.sdp);
    this.remoteSet = true;
    this.maybeConnect();
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.localDc?.close();
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }

  private scheduleGather(): void {
    if (this.gathered) return;
    this.gathered = true;
    queueMicrotask(() => {
      this.onicecandidate?.({
        candidate: { candidate: MOCK_CANDIDATE, sdpMid: "0", sdpMLineIndex: 0 },
      });
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    });
  }

  private maybeConnect(): void {
    if (this.connected || !this.localSet || !this.remoteSet) return;
    this.connected = true;
    queueMicrotask(() => {
      this.connectionState = "connected";
      this.onconnectionstatechange?.();
      if (this.localDc) {
        this.localDc._open();
      } else if (this.remoteToken) {
        const port = this.rendezvous.get(this.remoteToken);
        if (port) {
          const dc = new MockDataChannel(port);
          this.ondatachannel?.({ channel: dc });
          dc._open();
        }
      }
    });
  }
}

/**
 * A fresh mock factory with its own rendezvous map. Pass the SAME factory to
 * both peers/devices so their data channels can rendezvous.
 */
export function makeMockRtc(): RtcPeerConnectionFactory {
  const rendezvous = new Map<string, MessagePort>();
  return (() =>
    new MockPeerConnection(rendezvous)) as unknown as RtcPeerConnectionFactory;
}
