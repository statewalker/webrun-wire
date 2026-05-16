import type { ByteChannel } from "@statewalker/webrun-streams";
import type { RemoteParticipant, Room } from "livekit-client";

/**
 * livekit-client v2 `publishData` options shape. Reliable mode is ordered +
 * retransmitted; the bridged-byte contract requires this. `destinationIdentities`
 * restricts the publish to the named recipients so peer-to-peer pairings on the
 * same room don't fan out to every participant.
 */
type DataPublishOptions = {
  reliable?: boolean;
  destinationIdentities?: string[];
};

/**
 * Wrap a connected LiveKit `Room` plus a remote participant identity into a
 * `ByteChannel`. Outbound bytes are addressed only to the named participant;
 * inbound is filtered by sender identity.
 */
export function byteChannelFromLiveKit(room: Room, peerIdentity: string): ByteChannel {
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closedResolve = r;
  });
  let isClosed = false;

  const queue: Uint8Array[] = [];
  let pending: ((value: IteratorResult<Uint8Array>) => void) | null = null;

  const deliver = (bytes: Uint8Array): void => {
    if (isClosed) return;
    if (pending) {
      const r = pending;
      pending = null;
      r({ value: bytes, done: false });
    } else {
      queue.push(bytes);
    }
  };

  const onData = (payload: Uint8Array, participant?: RemoteParticipant): void => {
    if (!participant) return;
    if (participant.identity !== peerIdentity) return;
    deliver(new Uint8Array(payload));
  };

  const onDisconnected = (): void => {
    fireClose();
  };

  const onParticipantDisconnected = (participant: RemoteParticipant): void => {
    if (participant.identity !== peerIdentity) return;
    fireClose();
  };

  const fireClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    roomApi.off("dataReceived", onData as (...args: unknown[]) => void);
    roomApi.off("disconnected", onDisconnected);
    roomApi.off(
      "participantDisconnected",
      onParticipantDisconnected as (...args: unknown[]) => void,
    );
    if (pending) {
      const r = pending;
      pending = null;
      r({ value: undefined, done: true } as IteratorResult<Uint8Array>);
    }
    closedResolve();
  };

  // livekit-client surfaces events via a typed emitter; coerce to the
  // structural on/off shape we need.
  const roomApi = room as unknown as {
    on(ev: string, fn: (...args: unknown[]) => void): void;
    off(ev: string, fn: (...args: unknown[]) => void): void;
  };
  roomApi.on("dataReceived", onData as (...args: unknown[]) => void);
  roomApi.on("disconnected", onDisconnected);
  roomApi.on("participantDisconnected", onParticipantDisconnected as (...args: unknown[]) => void);

  const recv: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as Uint8Array, done: false });
          }
          if (isClosed) {
            return Promise.resolve({
              value: undefined,
              done: true,
            } as IteratorResult<Uint8Array>);
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending = resolve;
          });
        },
      };
    },
  };

  return {
    send(bytes) {
      if (isClosed) return;
      const publish = room.localParticipant as unknown as {
        publishData: (data: Uint8Array, options?: DataPublishOptions) => Promise<void>;
      };
      publish
        .publishData(bytes, { reliable: true, destinationIdentities: [peerIdentity] })
        .catch(() => {
          /* publish failure surfaces via disconnect events */
        });
    },
    recv,
    closed,
    close() {
      fireClose();
    },
  };
}
