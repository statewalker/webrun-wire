/**
 * @statewalker/webrun-streams-signaling
 *
 * Generic P2P signaling / connection-setup helpers, relocated from the retiring
 * `@statewalker/vcs-port-{webrtc,livekit}` packages and adapted to yield
 * webrun-streams {@link ByteChannel}s. Signaling here is *transport-setup only*:
 * it establishes a peer connection and hands back an established channel; the
 * byte transport + multiplexing is `@statewalker/webrun-streams`.
 *
 * - {@link PeerManager} — WebRTC peer discovery + connection over a signaling transport.
 * - {@link QrSignaling} — serverless offer/answer exchange via QR strings.
 * - {@link RoomManager} — LiveKit room membership + per-participant channels.
 *
 * @packageDocumentation
 */

export { byteChannelFromDataChannel, byteChannelFromRoom } from "./byte-channel.js";
export { PeerConnection } from "./peer-connection.js";
export { PeerManager, type PeerManagerOptions } from "./peer-manager.js";
export {
  createCompressedSignal,
  decodeSignal,
  encodeSignal,
  generateSessionId,
  parseCompressedSignal,
  QrSignaling,
  type QrSignalingOptions,
} from "./qr-signaling.js";
export { RoomManager } from "./room-manager.js";
export * from "./types.js";
