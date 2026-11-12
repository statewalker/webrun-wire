import type { Room } from "livekit-client";

type Listener = (event: MessageEvent) => void | Promise<void>;

/**
 * The largest reliable data packet LiveKit carries. Larger packets are
 * dropped rather than fragmented: a 1 MiB body was seen to arrive as zero
 * bytes, with no error on either side. A post past it ends the pipe instead.
 */
export const DEFAULT_MAX_FRAME_BYTES = 15 * 1024;

/**
 * The payload ceiling to give `overPipe`: 12 KiB, as this adapter has always
 * used, which leaves the port stack's framing (at most 134 bytes, spec D10)
 * well inside the frame limit.
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
 * Packets go out reliable (ordered, retransmitted) and addressed to that
 * participant only; inbound packets from anyone else are ignored. Both rooms
 * must already see each other: LiveKit drops a packet addressed to a
 * participant it has not announced.
 */
export function messageTargetOverLiveKit(
  room: Room,
  peerIdentity: string,
  options: MessageTargetOverLiveKitOptions = {},
): LiveKitMessageTarget {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  const listeners = new Set<Listener>();
  const life = new AbortController();
  const roomApi = room as unknown as {
    on(ev: string, fn: (...args: unknown[]) => void): void;
    off(ev: string, fn: (...args: unknown[]) => void): void;
  };
  const publisher = room.localParticipant as unknown as {
    publishData(
      data: Uint8Array,
      options: { reliable: boolean; destinationIdentities: string[] },
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
    const [payload, participant] = args as [Uint8Array, { identity?: string } | undefined];
    if (life.signal.aborted || participant?.identity !== peerIdentity) return;
    const event = new MessageEvent("message", { data: new Uint8Array(payload) });
    for (const listener of [...listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {}
    }
  };
  const onDisconnected = (): void =>
    end(new Error("webrun-streams-livekit: the room disconnected"));
  const onParticipantDisconnected = (...args: unknown[]): void => {
    if ((args[0] as { identity?: string } | undefined)?.identity !== peerIdentity) return;
    end(new Error(`webrun-streams-livekit: "${peerIdentity}" left the room`));
  };
  const end = (reason: Error): void => {
    if (life.signal.aborted) return;
    roomApi.off("dataReceived", onData);
    roomApi.off("disconnected", onDisconnected);
    roomApi.off("participantDisconnected", onParticipantDisconnected);
    life.abort(reason);
    wakeDrainWaiters();
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
            `webrun-streams-livekit: a ${bytes.byteLength}-byte packet exceeds maxFrameBytes (${maxFrameBytes}); LiveKit would drop it silently`,
          );
          end(err);
          throw err;
        }
        const size = bytes.byteLength;
        inFlight += size;
        publisher
          .publishData(bytes, { reliable: true, destinationIdentities: [peerIdentity] })
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
