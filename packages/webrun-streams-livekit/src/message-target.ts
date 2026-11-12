import type { Room } from "livekit-client";

type Listener = (event: MessageEvent) => void | Promise<void>;

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
export const DRAIN_LOW_WATER = 256 * 1024;

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
export interface LiveKitMessageTarget {
  /**
   * A `MessageTarget` (as `@statewalker/webrun-rpc` defines it) whose messages
   * are `Uint8Array`s, one reliable data packet each.
   */
  target: {
    addEventListener(type: "message", listener: Listener): void;
    removeEventListener(type: "message", listener: Listener): void;
    /** Publishes one packet. `TypeError` for non-bytes; `RangeError`, ending the pipe, past `maxFrameBytes`. */
    postMessage(message: unknown): void;
    /** Detaches from the room. The room itself stays connected: it is the caller's. */
    close(): Promise<void>;
    /** Bytes published whose `publishData` has not settled. */
    readonly bufferedAmount: number;
    /** Resolves once `bufferedAmount` is at most {@link DRAIN_LOW_WATER}, or the pipe ended. */
    whenDrained(): Promise<void>;
  };
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
  const listeners = new Set<Listener>();
  const life = new AbortController();
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
    if (inFlight > DRAIN_LOW_WATER && !life.signal.aborted) return;
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
    if (life.signal.aborted || participant?.identity !== peerIdentity) return;
    if (packetTopic === closeTopic) {
      end(new Error(`webrun-streams-livekit: "${peerIdentity}" closed the pipe`), false);
      return;
    }
    if (packetTopic !== topic) return;
    const event = new MessageEvent("message", { data: new Uint8Array(payload) });
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };
  const onDisconnected = (): void =>
    end(new Error("webrun-streams-livekit: the room disconnected"), false);
  const onParticipantDisconnected = (...args: unknown[]): void => {
    if ((args[0] as { identity?: string } | undefined)?.identity !== peerIdentity) return;
    end(new Error(`webrun-streams-livekit: "${peerIdentity}" left the room`), false);
  };
  /** `tellPeer`: the pipe ended on this side, and the room is still there to say so. */
  const end = (reason: Error, tellPeer = true): void => {
    if (life.signal.aborted) return;
    roomApi.off("dataReceived", onData);
    roomApi.off("disconnected", onDisconnected);
    roomApi.off("participantDisconnected", onParticipantDisconnected);
    life.abort(reason);
    wakeDrainWaiters();
    if (tellPeer) {
      publisher
        .publishData(new Uint8Array(0), {
          reliable: true,
          destinationIdentities: [peerIdentity],
          topic: closeTopic,
        })
        .catch(() => undefined);
    }
  };
  roomApi.on("dataReceived", onData);
  roomApi.on("disconnected", onDisconnected);
  roomApi.on("participantDisconnected", onParticipantDisconnected);

  return {
    signal: life.signal,
    maxMessageSize,
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
      postMessage(message) {
        const bytes = toBytes(message);
        if (!bytes) {
          throw new TypeError(
            `webrun-streams-livekit: a byte pipe carries Uint8Array, ArrayBuffer or a view, got ${Object.prototype.toString.call(message)}`,
          );
        }
        if (life.signal.aborted) return; // `signal` says so
        if (bytes.byteLength > maxFrameBytes) {
          const err = new RangeError(
            `webrun-streams-livekit: a ${bytes.byteLength}-byte packet exceeds maxFrameBytes (${maxFrameBytes})`,
          );
          end(err);
          throw err;
        }
        const size = bytes.byteLength;
        inFlight += size;
        publisher
          // A copy: livekit-client serializes the packet after an await.
          .publishData(bytes.slice(), {
            reliable: true,
            destinationIdentities: [peerIdentity],
            topic,
          })
          .then(
            () => undefined,
            (err: unknown) =>
              end(
                new Error(
                  `webrun-streams-livekit: a reliable publish failed: ${(err as Error)?.message ?? String(err)}`,
                  { cause: err },
                ),
              ),
          )
          .finally(() => {
            inFlight -= size;
            wakeDrainWaiters();
          });
      },
      async close() {
        listeners.clear();
        end(new Error("webrun-streams-livekit: closed locally"));
      },
      get bufferedAmount() {
        return inFlight;
      },
      whenDrained() {
        if (inFlight <= DRAIN_LOW_WATER || life.signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => drainWaiters.add(resolve));
      },
    },
  };
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}
