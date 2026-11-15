import {
  DEFAULT_DRAIN_LOW_WATER,
  type MessagePipe,
  type MessagePipeTarget,
  newMessagePipe,
} from "@statewalker/webrun-streams";
import type { Room } from "livekit-client";

/**
 * The largest data packet livekit-client (2.x) publishes: `RTCEngine` refuses
 * a larger one with a `PublishDataError`. A post past it ends the pipe with a
 * `RangeError` before it gets that far.
 */
export const DEFAULT_MAX_FRAME_BYTES = 64_000;

/** The topic this pipe's packets carry; packets on other topics are someone else's. */
export const DEFAULT_TOPIC = "webrun/port-stack";

/**
 * The topic of the goodbye a pipe sends when it ends on its own side. The room
 * stays connected, so without it the peer would never learn the pipe is gone.
 */
export const CLOSE_TOPIC = "webrun/port-stack/close";

/**
 * The payload ceiling to give `overPipe`: 12 KiB, as this adapter has always
 * used against a real SFU (an older client dropped larger reliable packets
 * silently), well inside the packet cap with the port stack's framing.
 */
export const DEFAULT_MAX_MESSAGE_SIZE = 12 * 1024;

/**
 * `whenDrained` resolves once the bytes whose publish has not settled are at
 * most this: the room can take more.
 */
export const DRAIN_LOW_WATER = DEFAULT_DRAIN_LOW_WATER;

export interface MessageTargetOverLiveKitOptions {
  /** The largest packet posted; past it the pipe ends with `RangeError`. Default {@link DEFAULT_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number;
  /** The payload ceiling to report. Default {@link DEFAULT_MAX_MESSAGE_SIZE}. */
  maxMessageSize?: number;
  /**
   * The data topic, default {@link DEFAULT_TOPIC}; the goodbye uses it with
   * `/close` appended. Both ends must agree. Use another to run two pipes to
   * the same participant.
   */
  topic?: string;
}

/** What `messageTargetOverLiveKit` gives: a pipe of bytes to one participant, its life, and its payload ceiling. */
export interface LiveKitMessageTarget extends MessagePipe {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one reliable data packet each. A post past
   * `maxFrameBytes` throws `RangeError` and ends the pipe; `close()` detaches
   * from the room, which stays connected (it is the caller's);
   * `bufferedAmount` counts bytes whose `publishData` has not settled, and
   * `whenDrained` waits for it to reach {@link DRAIN_LOW_WATER}.
   */
  target: MessagePipeTarget;
  /**
   * Aborts when the room disconnects, the participant leaves, a publish fails
   * (the stream above lost a message), or a post exceeds `maxFrameBytes`.
   * Pass it as `overPipe`'s `signal`.
   */
  signal: AbortSignal;
  /** Pass as `overPipe`'s `maxMessageSize`, so bodies are chunked under the packet limit. */
  maxMessageSize: number;
}

/**
 * One remote participant of a connected `Room` as a pipe of messages, for a
 * multiplexer to run over:
 *
 * ```ts
 * const { target, signal, maxMessageSize } = messageTargetOverLiveKit(room, "bob");
 * const { call } = await connect({
 *   mux: overPipe(target, { codec: msgpackCodec, side: "initiator", signal, maxMessageSize }),
 * });
 * ```
 *
 * Packets go out reliable (ordered, retransmitted), addressed to that
 * participant only and on their own topic; inbound packets from anyone else,
 * or on another topic, are ignored. The participant must already be in the
 * room (LiveKit drops packets to one it has not announced), or this throws.
 * When the pipe ends on this side — `close()`, an oversized post, a failed
 * publish — a goodbye on the close topic ends the peer's pipe too.
 */
export function messageTargetOverLiveKit(
  room: Room,
  peerIdentity: string,
  options: MessageTargetOverLiveKitOptions = {},
): LiveKitMessageTarget {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  const topic = options.topic ?? DEFAULT_TOPIC;
  const closeTopic = `${topic}/close`;
  // Packets to a participant LiveKit does not know are dropped by the server,
  // and no event would ever end the pipe.
  const remotes = (room as unknown as { remoteParticipants?: Map<string, unknown> })
    .remoteParticipants;
  const present = remotes
    ? remotes.has(peerIdentity) ||
      [...remotes.values()].some((p) => (p as { identity?: string }).identity === peerIdentity)
    : true;
  if (!present) {
    throw new Error(
      `messageTargetOverLiveKit: "${peerIdentity}" is not in the room; wait for it to join`,
    );
  }
  const roomApi = room as unknown as {
    on(ev: string, fn: (...args: unknown[]) => void): void;
    off(ev: string, fn: (...args: unknown[]) => void): void;
  };
  const publisher = room.localParticipant as unknown as {
    publishData(
      data: Uint8Array,
      options: { reliable: boolean; destinationIdentities: string[]; topic: string },
    ): Promise<void>;
  };
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();
  const wakeDrainWaiters = (): void => {
    if (inFlight > DRAIN_LOW_WATER) return;
    for (const w of [...drainWaiters]) w();
    drainWaiters.clear();
  };

  const onData = (...args: unknown[]): void => {
    const [payload, participant, , packetTopic] = args as [
      Uint8Array,
      { identity?: string } | undefined,
      unknown,
      string | undefined,
    ];
    if (participant?.identity !== peerIdentity) return;
    if (packetTopic === closeTopic) {
      control.end(new Error(`webrun-streams-livekit: "${peerIdentity}" closed the pipe`));
      return;
    }
    if (packetTopic !== topic) return;
    control.deliver(payload);
  };
  const onDisconnected = (): void =>
    control.end(new Error("webrun-streams-livekit: the room disconnected"));
  const onParticipantDisconnected = (...args: unknown[]): void => {
    if ((args[0] as { identity?: string } | undefined)?.identity !== peerIdentity) return;
    control.end(new Error(`webrun-streams-livekit: "${peerIdentity}" left the room`));
  };
  const control = newMessagePipe(
    {
      send: (bytes) => {
        const size = bytes.byteLength;
        inFlight += size;
        publisher
          .publishData(bytes, { reliable: true, destinationIdentities: [peerIdentity], topic })
          .then(
            () => undefined,
            // The stream above lost a message: end, and tell the peer.
            (err: unknown) =>
              control.end(
                new Error(
                  `webrun-streams-livekit: a reliable publish failed: ${(err as Error)?.message ?? String(err)}`,
                  { cause: err },
                ),
                true,
              ),
          )
          .finally(() => {
            inFlight -= size;
            wakeDrainWaiters();
          });
      },
      bufferedAmount: () => inFlight,
      whenDrained: () => new Promise<void>((resolve) => drainWaiters.add(resolve)),
      /** `local`: the pipe ended on this side, and the room is still there to say so. */
      close: (local) => {
        roomApi.off("dataReceived", onData);
        roomApi.off("disconnected", onDisconnected);
        roomApi.off("participantDisconnected", onParticipantDisconnected);
        drainWaiters.clear();
        if (local) {
          publisher
            .publishData(new Uint8Array(0), {
              reliable: true,
              destinationIdentities: [peerIdentity],
              topic: closeTopic,
            })
            .catch(() => undefined);
        }
      },
    },
    {
      name: "webrun-streams-livekit",
      maxFrameBytes,
      maxMessageSize,
      // livekit-client serializes the packet after an await, and may reuse
      // the payload buffer it hands out.
      copyOnSend: true,
      copyOnDeliver: true,
    },
  );
  roomApi.on("dataReceived", onData);
  roomApi.on("disconnected", onDisconnected);
  roomApi.on("participantDisconnected", onParticipantDisconnected);
  return control.pipe as LiveKitMessageTarget;
}
