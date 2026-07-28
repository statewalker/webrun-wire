/**
 * WebRTC peer connection lifecycle (single connection).
 *
 * Relocated from `@statewalker/vcs-port-webrtc`'s `PeerManager` and neutralised
 * (no Git/VCS coupling). Handles signaling, ICE candidate gathering and data
 * channel creation for one peer, in either "initiator" (creates offer) or
 * "responder" (creates answer) role.
 *
 * Adaptations vs. the original:
 *  - `new RTCPeerConnection(...)` is behind an injectable {@link RtcPeerConnectionFactory}
 *    so tests run without a real WebRTC stack.
 *  - remote ICE candidates are added as plain `RTCIceCandidateInit` (accepted by
 *    `addIceCandidate`) instead of constructing a global `RTCIceCandidate`,
 *    which does not exist outside a browser.
 *  - `open()` yields a webrun-streams {@link ByteChannel} rather than a `MessagePort`.
 */

import type { ByteChannel } from "@statewalker/webrun-streams";
import { byteChannelFromDataChannel } from "./byte-channel.js";
import type {
  ConnectionState,
  IceCandidate,
  PeerConnectionEvents,
  PeerRole,
  SessionDescription,
  SignalingMessage,
  WebRtcConnectionOptions,
} from "./types.js";
import { DEFAULT_ICE_SERVERS } from "./types.js";

const DEFAULT_CONNECTION_TIMEOUT = 30000;
const DEFAULT_ICE_GATHERING_TIMEOUT = 5000;
const DEFAULT_CHANNEL_LABEL = "webrun-data";

type EventListener<K extends keyof PeerConnectionEvents> = PeerConnectionEvents[K];

/**
 * Manages a single WebRTC peer connection lifecycle.
 */
export class PeerConnection {
  private readonly role: PeerRole;
  private readonly options: WebRtcConnectionOptions;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private state: ConnectionState = "new";

  private readonly listeners: Map<
    keyof PeerConnectionEvents,
    Set<EventListener<keyof PeerConnectionEvents>>
  > = new Map();

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  private collectedCandidates: IceCandidate[] = [];
  private iceGatheringComplete = false;

  constructor(role: PeerRole, options: WebRtcConnectionOptions = {}) {
    this.role = role;
    this.options = options;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getRole(): PeerRole {
    return this.role;
  }

  getDataChannel(): RTCDataChannel | null {
    return this.dataChannel;
  }

  on<K extends keyof PeerConnectionEvents>(event: K, listener: PeerConnectionEvents[K]): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener as EventListener<keyof PeerConnectionEvents>);
    return this;
  }

  off<K extends keyof PeerConnectionEvents>(event: K, listener: PeerConnectionEvents[K]): this {
    this.listeners.get(event)?.delete(listener as EventListener<keyof PeerConnectionEvents>);
    return this;
  }

  private emit<K extends keyof PeerConnectionEvents>(
    event: K,
    ...args: Parameters<PeerConnectionEvents[K]>
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        (listener as (...args: Parameters<PeerConnectionEvents[K]>) => void)(...args);
      }
    }
  }

  private createRtc(config: RTCConfiguration): RTCPeerConnection {
    const factory = this.options.rtc ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
    return factory(config);
  }

  private initConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    this.setState("connecting");
    const iceServers = this.options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.pc = this.createRtc({ iceServers });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.collectedCandidates.push({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
        this.emit("signal", {
          type: "candidate",
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        });
      }
    };

    this.pc.onicegatheringstatechange = () => {
      if (this.pc?.iceGatheringState === "complete") {
        this.iceGatheringComplete = true;
        this.emit("signal", { type: "ready" });
      }
    };

    this.pc.onconnectionstatechange = () => {
      switch (this.pc?.connectionState) {
        case "connected":
          this.setState("connected");
          break;
        case "disconnected":
          this.setState("disconnected");
          break;
        case "failed":
          this.setState("failed");
          this.emit("error", new Error("Connection failed"));
          break;
        case "closed":
          this.setState("closed");
          break;
      }
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };

    return this.pc;
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) return;
    this.dataChannel.binaryType = "arraybuffer";
    this.dataChannel.onopen = () => this.emit("open");
    this.dataChannel.onclose = () => this.emit("close");
    this.dataChannel.onerror = (event) => {
      const errorEvent = event as RTCErrorEvent;
      this.emit("error", errorEvent.error ?? new Error("DataChannel error"));
    };
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit("stateChange", newState);
    }
  }

  /**
   * Start connection as initiator: create the data channel and offer, emit the
   * offer via the `signal` event.
   */
  async connect(): Promise<void> {
    if (this.role !== "initiator") {
      throw new Error("connect() should only be called by initiator");
    }
    const pc = this.initConnection();

    const label = this.options.channelLabel ?? DEFAULT_CHANNEL_LABEL;
    this.dataChannel = pc.createDataChannel(label, {
      ordered: this.options.ordered ?? true,
      maxRetransmits: this.options.maxRetransmits,
    });
    this.setupDataChannel();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (offer.sdp) {
      this.emit("signal", { type: "offer", sdp: offer.sdp });
    }
  }

  /** Handle a signaling message from the remote peer. */
  async handleSignal(message: SignalingMessage): Promise<void> {
    const pc = this.initConnection();
    switch (message.type) {
      case "offer":
        await this.handleOffer(pc, message.sdp);
        break;
      case "answer":
        await this.handleAnswer(pc, message.sdp);
        break;
      case "candidate":
        await this.handleCandidate(pc, message.candidate);
        break;
      case "ready":
        break;
    }
  }

  private async handleOffer(pc: RTCPeerConnection, sdp: string): Promise<void> {
    if (this.role !== "responder") {
      throw new Error("Received offer but not in responder role");
    }
    await pc.setRemoteDescription({ type: "offer", sdp });
    this.remoteDescriptionSet = true;
    await this.processPendingCandidates(pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (answer.sdp) {
      this.emit("signal", { type: "answer", sdp: answer.sdp });
    }
  }

  private async handleAnswer(pc: RTCPeerConnection, sdp: string): Promise<void> {
    if (this.role !== "initiator") {
      throw new Error("Received answer but not in initiator role");
    }
    await pc.setRemoteDescription({ type: "answer", sdp });
    this.remoteDescriptionSet = true;
    await this.processPendingCandidates(pc);
  }

  private async handleCandidate(pc: RTCPeerConnection, candidate: IceCandidate): Promise<void> {
    const init: RTCIceCandidateInit = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    };
    if (this.remoteDescriptionSet) {
      await pc.addIceCandidate(init);
    } else {
      this.pendingCandidates.push(init);
    }
  }

  private async processPendingCandidates(pc: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      await pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];
  }

  /**
   * Wait for ICE gathering to complete (batch/QR signaling). Resolves early on
   * timeout, using whatever candidates were collected.
   */
  async waitForIceGathering(): Promise<void> {
    if (this.iceGatheringComplete) return;
    const timeout = this.options.iceGatheringTimeout ?? DEFAULT_ICE_GATHERING_TIMEOUT;

    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.iceGatheringComplete) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 20);
      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, timeout);
    });
  }

  /** Local session description after negotiation. */
  getLocalDescription(): SessionDescription | null {
    if (!this.pc?.localDescription) return null;
    return {
      type: this.pc.localDescription.type as "offer" | "answer",
      sdp: this.pc.localDescription.sdp,
    };
  }

  /** Collected ICE candidates (batch/QR signaling). */
  getCollectedCandidates(): IceCandidate[] {
    return [...this.collectedCandidates];
  }

  /**
   * Resolve with a {@link ByteChannel} once the data channel opens. Rejects on
   * error or after {@link WebRtcConnectionOptions.connectionTimeout}.
   */
  open(): Promise<ByteChannel> {
    const timeout = this.options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    return new Promise<ByteChannel>((resolve, reject) => {
      const existing = this.dataChannel;
      if (existing && existing.readyState === "open") {
        resolve(byteChannelFromDataChannel(existing));
        return;
      }
      const cleanup = () => {
        this.off("open", onOpen);
        this.off("error", onError);
        clearTimeout(timer);
      };
      const onOpen = () => {
        cleanup();
        const ch = this.dataChannel;
        if (ch) resolve(byteChannelFromDataChannel(ch));
        else reject(new Error("No data channel after open"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.on("open", onOpen);
      this.on("error", onError);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Connection timeout after ${timeout}ms`));
      }, timeout);
    });
  }

  /** Close the connection and release resources. */
  close(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.setState("closed");
    this.listeners.clear();
  }
}
