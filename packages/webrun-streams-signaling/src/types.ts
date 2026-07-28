/**
 * Signaling / connection-setup types.
 *
 * Relocated from the retiring `@statewalker/vcs-port-{webrtc,livekit}` packages
 * and neutralised: nothing here is VCS/Git-specific. These describe the generic
 * P2P handshake (WebRTC offer/answer/ICE, QR payloads, LiveKit room membership)
 * used to *establish* a channel. The byte transport itself is
 * `@statewalker/webrun-streams` (a `ByteChannel`), not this package.
 */

/** WebRTC peer role in the connection. */
export type PeerRole = "initiator" | "responder";

/** Connection state for a WebRTC peer. */
export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

/** ICE candidate for connection establishment. */
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** Session description for WebRTC signaling. */
export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** Signaling message exchanged between peers. */
export type SignalingMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "ready" };

/**
 * Compressed signaling data for QR code exchange.
 *
 * Contains everything needed to establish a connection in a single compact
 * payload suitable for QR codes.
 */
export interface CompressedSignal {
  /** Protocol version */
  v: number;
  /** Session ID for matching peers */
  id: string;
  /** Peer role */
  role: PeerRole;
  /** SDP offer or answer (compressed) */
  sdp: string;
  /** ICE candidates (compressed) */
  ice: string[];
}

/**
 * Factory for the underlying WebRTC peer connection. Defaults to
 * `new RTCPeerConnection(config)`; tests inject a mock so no real vendor
 * network is required.
 */
export type RtcPeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

/** Options for creating a WebRTC peer connection. */
export interface WebRtcConnectionOptions {
  /** ICE servers for connection establishment */
  iceServers?: RTCIceServer[];
  /** Timeout for connection establishment (ms) */
  connectionTimeout?: number;
  /** Timeout for ICE gathering (ms) */
  iceGatheringTimeout?: number;
  /** Data channel label */
  channelLabel?: string;
  /** Whether to use ordered delivery */
  ordered?: boolean;
  /** Maximum retransmits for unreliable mode */
  maxRetransmits?: number;
  /** Underlying peer-connection factory (injected in tests). */
  rtc?: RtcPeerConnectionFactory;
}

/** Events emitted by a low-level {@link PeerConnection}. */
export interface PeerConnectionEvents {
  /** Emitted when connection state changes */
  stateChange: (state: ConnectionState) => void;
  /** Emitted when a signaling message is ready to send */
  signal: (message: SignalingMessage) => void;
  /** Emitted when the data channel opens */
  open: () => void;
  /** Emitted when the connection closes */
  close: () => void;
  /** Emitted on error */
  error: (error: Error) => void;
}

/**
 * A signaling transport routes {@link SignalingMessage}s to and from peers by
 * id. It is the rendezvous side-channel over which the WebRTC handshake flows;
 * the concrete implementation (websocket, room, in-memory bus) is out of scope
 * for this package. Tests provide an in-memory pair.
 */
export interface SignalingTransport {
  /** This endpoint's own peer id. */
  readonly localId: string;
  /** Send a signaling message to a specific peer. */
  send(to: string, msg: SignalingMessage): void;
  /** Subscribe to inbound signaling messages; returns an unsubscribe fn. */
  onMessage(handler: (from: string, msg: SignalingMessage) => void): () => void;
}

/** Default ICE servers (public STUN servers). */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Information about a participant in a room.
 * Relocated from `@statewalker/vcs-port-livekit`.
 */
export interface ParticipantInfo {
  /** Unique identity string */
  identity: string;
  /** Display name (may be empty) */
  name: string;
  /** Whether the participant is currently connected */
  connected: boolean;
}

/**
 * Narrow structural view of a LiveKit `Room`. Kept structural (rather than a
 * hard `import` of `livekit-client`) so the vendor stays an *optional*
 * peerDependency and tests can supply a mock without installing it. A real
 * `livekit-client` `Room` satisfies this shape.
 */
export interface RoomParticipantLike {
  identity: string;
  name?: string;
}

export interface RoomLocalParticipantLike {
  publishData(
    data: Uint8Array,
    opts?: { reliable?: boolean; destinationIdentities?: string[] },
  ): Promise<void>;
}

export interface RoomLike {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  readonly remoteParticipants: Map<string, RoomParticipantLike>;
  readonly localParticipant: RoomLocalParticipantLike;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  off(event: string, cb: (...args: unknown[]) => void): unknown;
}

/** Options for a {@link RoomManager}. */
export interface RoomManagerOptions {
  /** Room server URL (e.g. "ws://localhost:7880"). */
  url: string;
  /** Resolve an access token for a given room name (out of scope: token issuer). */
  getToken: (room: string) => Promise<string>;
  /** Room factory. Production: `() => new Room()` from `livekit-client`. */
  roomFactory: () => RoomLike;
}

/** LiveKit `RoomEvent` string values used here (avoids a runtime vendor import). */
export const ROOM_EVENT = {
  participantConnected: "participantConnected",
  participantDisconnected: "participantDisconnected",
  dataReceived: "dataReceived",
} as const;
