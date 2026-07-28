/**
 * Room membership manager over a LiveKit-style `Room`.
 *
 * Relocated from `@statewalker/vcs-port-livekit`'s `RoomManager` and adapted to
 * the target API: `join`/`participants`/`channelTo`/`leave`. Participant
 * tracking is the original event-wiring; `channelTo` yields a per-participant
 * webrun-streams {@link ByteChannel} (see {@link byteChannelFromRoom}).
 *
 * The vendor (`livekit-client`) stays an optional peerDependency: the `Room` is
 * injected via {@link RoomManagerOptions.roomFactory} (production:
 * `() => new Room()`), so this module never hard-imports it.
 */

import type { ByteChannel } from "@statewalker/webrun-streams";
import { byteChannelFromRoom } from "./byte-channel.js";
import type { RoomLike, RoomManagerOptions, RoomParticipantLike } from "./types.js";
import { ROOM_EVENT } from "./types.js";

export class RoomManager {
  private readonly options: RoomManagerOptions;
  private room: RoomLike | null = null;

  private readonly seen: string[] = [];
  private live: ((identity: string) => void) | null = null;
  private endParticipants: (() => void) | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(options: RoomManagerOptions) {
    this.options = options;
  }

  /** Join a room by name (token is resolved via `options.getToken`). */
  async join(room: string): Promise<void> {
    const token = await this.options.getToken(room);
    const instance = this.options.roomFactory();
    this.room = instance;

    const onJoin = (...args: unknown[]): void => {
      const participant = args[0] as RoomParticipantLike;
      this.seen.push(participant.identity);
      this.live?.(participant.identity);
    };
    instance.on(ROOM_EVENT.participantConnected, onJoin);
    this.cleanups.push(() => instance.off(ROOM_EVENT.participantConnected, onJoin));

    await instance.connect(this.options.url, token);

    for (const [, participant] of instance.remoteParticipants) {
      this.seen.push(participant.identity);
      this.live?.(participant.identity);
    }
  }

  /** Observe participant identities: those already present, then joiners. */
  participants(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => {
        const buffer: string[] = [...this.seen];
        let cursor = 0;
        let pending: ((r: IteratorResult<string>) => void) | null = null;
        let ended = false;

        this.live = (identity: string) => {
          if (pending) {
            const resolve = pending;
            pending = null;
            resolve({ value: identity, done: false });
          } else {
            buffer.push(identity);
          }
        };
        this.endParticipants = () => {
          ended = true;
          if (pending) {
            const resolve = pending;
            pending = null;
            resolve({ value: undefined, done: true } as IteratorResult<string>);
          }
        };

        return {
          next: (): Promise<IteratorResult<string>> => {
            if (cursor < buffer.length) {
              return Promise.resolve({ value: buffer[cursor++], done: false });
            }
            if (ended) {
              return Promise.resolve({ value: undefined, done: true } as IteratorResult<string>);
            }
            return new Promise<IteratorResult<string>>((resolve) => {
              pending = resolve;
            });
          },
        };
      },
    };
  }

  /** Open a {@link ByteChannel} to a specific participant. */
  async channelTo(peerId: string): Promise<ByteChannel> {
    if (!this.room) throw new Error("channelTo() before join()");
    return byteChannelFromRoom(this.room, peerId);
  }

  /** Leave the room: unsubscribe and disconnect. */
  async leave(): Promise<void> {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    this.endParticipants?.();
    this.live = null;
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect();
  }
}
