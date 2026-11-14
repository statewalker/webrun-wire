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
 * Build a {@link ByteChannel} to a single room participant over a LiveKit-style
 * `Room`. Outbound bytes are published to `peerId`; inbound `dataReceived`
 * events from `peerId` feed `recv`. This is the per-participant filtering the
 * retired `vcs-port-livekit` `livekit-port` performed, adapted to ByteChannel.
 */
export function byteChannelFromRoom(room: RoomLike, peerId: string): ByteChannel {
  const queue = makeByteQueue();
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  let ended = false;

  const onData = (...args: unknown[]): void => {
    const payload = args[0];
    const participant = args[1] as { identity?: string } | undefined;
    // A packet with no participant is the server's, not the peer's.
    if (participant?.identity !== peerId) return;
    if (payload != null) queue.push(toBytes(payload));
  };
  const onParticipantDisconnected = (...args: unknown[]): void => {
    if ((args[0] as { identity?: string } | undefined)?.identity === peerId) end();
  };
  // The channel ends with the room or with the peer: otherwise nothing above
  // it would ever learn the other end is gone.
  const end = (): void => {
    if (ended) return;
    ended = true;
    room.off(ROOM_EVENT.dataReceived, onData);
    room.off(ROOM_EVENT.participantDisconnected, onParticipantDisconnected);
    room.off(ROOM_EVENT.disconnected, end);
    queue.done();
    closedResolve();
  };

  room.on(ROOM_EVENT.dataReceived, onData);
  room.on(ROOM_EVENT.participantDisconnected, onParticipantDisconnected);
  room.on(ROOM_EVENT.disconnected, end);

  return {
    send(bytes) {
      if (ended) return;
      void room.localParticipant
        .publishData(bytes, { reliable: true, destinationIdentities: [peerId] })
        // A reliable publish that fails lost a message: the stream above is broken.
        .catch(end);
    },
    recv: queue.recv,
    closed,
    close: end,
  };
}
