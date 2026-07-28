/**
 * ByteChannel adapters — the MessagePort→ByteChannel-style shims the relocation
 * requires. The original `vcs-port-*` helpers surfaced an established
 * connection as a Web `MessagePort` (via the out-of-scope `datachannel-port` /
 * `livekit-port` byte bridges); here the established primitive is wrapped
 * *directly* as a webrun-streams {@link ByteChannel} so the byte transport +
 * multiplexing (`emulateMux`) can run on top.
 */
import type { ByteChannel } from "@statewalker/webrun-streams";
import { makeByteQueue, toBytes } from "./byte-queue.js";
import type { RoomLike } from "./types.js";
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

  const onData = (...args: unknown[]): void => {
    const payload = args[0];
    const participant = args[1] as { identity?: string } | undefined;
    if (participant && participant.identity !== peerId) return;
    if (payload != null) queue.push(toBytes(payload));
  };

  room.on(ROOM_EVENT.dataReceived, onData);

  return {
    send(bytes) {
      void room.localParticipant
        .publishData(bytes, { reliable: true, destinationIdentities: [peerId] })
        .catch(() => {
          /* room closed */
        });
    },
    recv: queue.recv,
    closed,
    close() {
      room.off(ROOM_EVENT.dataReceived, onData);
      queue.done();
      closedResolve();
    },
  };
}
