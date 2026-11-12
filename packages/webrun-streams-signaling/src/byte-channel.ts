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
 * Wrap an established `RTCDataChannel` as a {@link ByteChannel}. Outbound bytes
 * go through `channel.send`; inbound `message` events feed `recv`.
 */
export function byteChannelFromDataChannel(channel: RTCDataChannel): ByteChannel {
  const queue = makeByteQueue();
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });

  const onMessage = (ev: MessageEvent): void => queue.push(toBytes(ev.data));
  const onClose = (): void => {
    queue.done();
    closedResolve();
  };

  channel.binaryType = "arraybuffer";
  channel.addEventListener("message", onMessage as EventListener);
  channel.addEventListener("close", onClose as EventListener);

  return {
    send(bytes) {
      try {
        // Cast around the DOM lib's `ArrayBufferView<ArrayBuffer>` overload:
        // a plain `Uint8Array` is `ArrayBufferLike`-backed at the type level.
        channel.send(bytes as unknown as ArrayBufferView<ArrayBuffer>);
      } catch {
        /* channel closed by peer */
      }
    },
    recv: queue.recv,
    closed,
    close() {
      channel.removeEventListener("message", onMessage as EventListener);
      channel.removeEventListener("close", onClose as EventListener);
      try {
        channel.close();
      } catch {
        /* ignore */
      }
      queue.done();
      closedResolve();
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
