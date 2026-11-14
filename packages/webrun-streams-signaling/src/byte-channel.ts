/**
 * ByteChannel adapters — the MessagePort→ByteChannel-style shims the relocation
 * requires. The original `vcs-port-*` helpers surfaced an established
 * connection as a Web `MessagePort` (via the out-of-scope `datachannel-port` /
 * `livekit-port` byte bridges); here the established primitive is wrapped
 * *directly* as a {@link ByteChannel} so the byte transport +
 * multiplexing (`webrun-rpc`'s port stack, via `messageTargetOverByteChannel`) can run on top.
 */

import { makeByteQueue, toBytes } from "./byte-queue.js";
import type { ByteChannel, RoomLike } from "./types.js";
import { ROOM_EVENT } from "./types.js";

/**
 * `whenDrained` resolves once the bytes sent and not yet written out are at
 * most this: the transport can take more. The same mark the ws, peerjs,
 * livekit and webrtc adapters use.
 */
export const DRAIN_LOW_WATER = 256 * 1024;

/**
 * Wrap an established `RTCDataChannel` as a {@link ByteChannel}. Outbound bytes
 * go through `channel.send`; inbound `message` events feed `recv`. A message
 * that is not bytes, or a `send` that fails (a closed channel, Chrome's full
 * send queue), ends the channel: the stream above it lost a message.
 * `bufferedAmount` is the data channel's; `whenDrained` waits for its
 * `bufferedamountlow`.
 */
export function byteChannelFromDataChannel(channel: RTCDataChannel): ByteChannel {
  const queue = makeByteQueue();
  let closedResolve!: () => void;
  let ended = false;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  const drainWaiters = new Set<() => void>();

  const onMessage = (ev: MessageEvent): void => {
    if (ended) return;
    let bytes: Uint8Array;
    try {
      bytes = toBytes(ev.data);
    } catch {
      close();
      return;
    }
    queue.push(bytes);
  };
  const onDrained = (): void => {
    for (const w of [...drainWaiters]) w();
    drainWaiters.clear();
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    channel.removeEventListener("message", onMessage as EventListener);
    channel.removeEventListener("close", end);
    channel.removeEventListener("bufferedamountlow", onDrained);
    queue.done();
    closedResolve();
    onDrained();
  };
  const close = (): void => {
    end();
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  };

  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = DRAIN_LOW_WATER;
  channel.addEventListener("message", onMessage as EventListener);
  channel.addEventListener("close", end);
  channel.addEventListener("bufferedamountlow", onDrained);

  return {
    send(bytes) {
      if (ended) return;
      try {
        // Cast around the DOM lib's `ArrayBufferView<ArrayBuffer>` overload:
        // a plain `Uint8Array` is `ArrayBufferLike`-backed at the type level.
        channel.send(bytes as unknown as ArrayBufferView<ArrayBuffer>);
      } catch {
        close();
      }
    },
    recv: queue.recv,
    closed,
    close,
    get bufferedAmount() {
      return channel.bufferedAmount ?? 0;
    },
    whenDrained() {
      if (ended || (channel.bufferedAmount ?? 0) <= DRAIN_LOW_WATER) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
  };
}

/**
 * The topic a {@link byteChannelFromRoom} channel's packets carry, the same
 * default as `webrun-streams-livekit`'s `messageTargetOverLiveKit`; packets on
 * other topics are someone else's. The goodbye goes on this topic with
 * `/close` appended, as there.
 */
export const DEFAULT_ROOM_TOPIC = "webrun/port-stack";

/**
 * The largest packet a {@link byteChannelFromRoom} channel publishes, as in
 * `webrun-streams-livekit`: livekit-client (2.x) refuses a larger one.
 */
export const DEFAULT_ROOM_MAX_FRAME_BYTES = 64_000;

/** Options for {@link byteChannelFromRoom}. */
export interface ByteChannelFromRoomOptions {
  /**
   * The data topic, default {@link DEFAULT_ROOM_TOPIC}; the goodbye uses it
   * with `/close` appended. Both ends must agree. Use another to run two
   * channels to the same participant.
   */
  topic?: string;
  /** The largest packet sent; past it `send` ends the channel and throws `RangeError`. Default {@link DEFAULT_ROOM_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number;
}

/**
 * Build a {@link ByteChannel} to a single room participant over a LiveKit-style
 * `Room`. Outbound bytes are published reliably to `peerId` on the channel's
 * topic; inbound `dataReceived` events from `peerId` on that topic feed
 * `recv`. The packets and the goodbye follow `webrun-streams-livekit`'s
 * conventions, so the port stack over this channel talks to one over
 * `messageTargetOverLiveKit` with the same topic.
 *
 * The channel ends when the room disconnects, the participant leaves, the
 * peer's goodbye arrives, a reliable publish fails, or a `send` exceeds
 * `maxFrameBytes`. When it ends on this side, a goodbye on the close topic
 * ends the peer's channel too: the room stays connected, so nothing else would.
 * `bufferedAmount` counts bytes whose publish has not settled.
 */
export function byteChannelFromRoom(
  room: RoomLike,
  peerId: string,
  options: ByteChannelFromRoomOptions = {},
): ByteChannel {
  const topic = options.topic ?? DEFAULT_ROOM_TOPIC;
  const closeTopic = `${topic}/close`;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_ROOM_MAX_FRAME_BYTES;
  const queue = makeByteQueue();
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  let ended = false;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  const wakeDrainWaiters = (): void => {
    if (inFlight > DRAIN_LOW_WATER && !ended) return;
    for (const w of [...drainWaiters]) w();
    drainWaiters.clear();
  };

  const onData = (...args: unknown[]): void => {
    const [payload, participant, , packetTopic] = args as [
      unknown,
      { identity?: string } | undefined,
      unknown,
      string | undefined,
    ];
    // A packet with no participant is the server's, not the peer's.
    if (ended || participant?.identity !== peerId) return;
    if (packetTopic === closeTopic) {
      end(false);
      return;
    }
    if (packetTopic !== topic || payload == null) return;
    let bytes: Uint8Array;
    try {
      bytes = toBytes(payload);
    } catch {
      end(true);
      return;
    }
    queue.push(bytes);
  };
  const onParticipantDisconnected = (...args: unknown[]): void => {
    if ((args[0] as { identity?: string } | undefined)?.identity === peerId) end(false);
  };
  const onDisconnected = (): void => end(false);
  // The channel ends with the room, with the peer, or with the peer's
  // goodbye: otherwise nothing above it would ever learn the other end is gone.
  /** `tellPeer`: it ended on this side, and the room is still there to say so. */
  const end = (tellPeer: boolean): void => {
    if (ended) return;
    ended = true;
    room.off(ROOM_EVENT.dataReceived, onData);
    room.off(ROOM_EVENT.participantDisconnected, onParticipantDisconnected);
    room.off(ROOM_EVENT.disconnected, onDisconnected);
    queue.done();
    closedResolve();
    wakeDrainWaiters();
    if (tellPeer) {
      room.localParticipant
        .publishData(new Uint8Array(0), {
          reliable: true,
          destinationIdentities: [peerId],
          topic: closeTopic,
        })
        .catch(() => undefined);
    }
  };

  room.on(ROOM_EVENT.dataReceived, onData);
  room.on(ROOM_EVENT.participantDisconnected, onParticipantDisconnected);
  room.on(ROOM_EVENT.disconnected, onDisconnected);

  return {
    send(bytes) {
      if (ended) return;
      if (bytes.byteLength > maxFrameBytes) {
        end(true);
        throw new RangeError(
          `webrun-streams-signaling: a ${bytes.byteLength}-byte packet exceeds maxFrameBytes (${maxFrameBytes})`,
        );
      }
      const size = bytes.byteLength;
      inFlight += size;
      room.localParticipant
        .publishData(bytes, { reliable: true, destinationIdentities: [peerId], topic })
        // A reliable publish that fails lost a message: the stream above is broken.
        .then(
          () => undefined,
          () => end(true),
        )
        .finally(() => {
          inFlight -= size;
          wakeDrainWaiters();
        });
    },
    recv: queue.recv,
    closed,
    close: () => end(true),
    get bufferedAmount() {
      return inFlight;
    },
    whenDrained() {
      if (ended || inFlight <= DRAIN_LOW_WATER) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.add(resolve));
    },
  };
}
