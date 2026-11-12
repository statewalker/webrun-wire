import type {
  Connection,
  DialProtocolOptions,
  Libp2p,
  PeerId,
  Stream,
  StreamHandlerOptions,
} from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { closeStream } from "./duplex-over-stream.js";
import { messageTargetOverStream, type StreamMessageTarget } from "./message-target-over-stream.js";
import { openGatedStream } from "./stream-gate.js";

/** The protocol a port's stream negotiates unless told otherwise. */
export const DEFAULT_PORT_PROTOCOL = "/webrun-ports/1.0.0";

/**
 * 256 KiB: what one message on a port may carry before `webrun-rpc`'s stream tier chunks a body.
 * A port waits for each chunk's confirmation, so a larger chunk means fewer round trips; well
 * under `messageTargetOverStream`'s 64 MiB frame ceiling.
 */
export const DEFAULT_PORT_MAX_MESSAGE_SIZE = 256 * 1024;

/**
 * How a port's messages become bytes on its stream and back: any value the stream tier posts
 * (objects holding `Uint8Array` chunks, serialised errors). `webrun-msgpack`'s `serialize` and
 * `deserialize` fit: `{ encode: serialize, decode: deserialize }`.
 */
export interface ValueCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

type Listener = (event: MessageEvent) => void | Promise<void>;

/**
 * The stream limits a port mux asks libp2p for unless told otherwise: every concurrent call is a
 * stream, and libp2p's own default (32 per protocol) would reset the 33rd.
 */
export const DEFAULT_PORT_STREAM_LIMIT = 1024;

/** One port: a libp2p stream as a `MessageTarget` of values, with its close signal on it. */
export type StreamPort = Omit<
  StreamMessageTarget["target"],
  "addEventListener" | "removeEventListener"
> & {
  addEventListener(type: "message", listener: Listener): void;
  removeEventListener(type: "message", listener: Listener): void;
};

/** What the serving side learns about a port the peer opened. */
export interface InboundPortInfo {
  /** The peer libp2p's Noise handshake proved for the connection the stream came on. */
  remotePeer: PeerId;
  connection: Connection;
}

export interface Libp2pPortMuxOptions {
  node: Libp2p;
  /** Encodes each message as one frame; see {@link ValueCodec}. Both ends must agree. */
  codec: ValueCodec;
  /** The protocol each port's stream negotiates. Default {@link DEFAULT_PORT_PROTOCOL}. */
  protocol?: string;
  /** Whom `openPort` dials. Required to open ports; a serving-only mux leaves it out. */
  peer?: PeerId | Multiaddr;
  /**
   * Called for each port the peer opens (each inbound stream). Return `false` to refuse it: the
   * stream is aborted. Leave it out to accept none (the protocol is not handled).
   */
  onPort?: (port: StreamPort, info: InboundPortInfo) => boolean | undefined;
  /** Reported as `maxMessageSize`. Default {@link DEFAULT_PORT_MAX_MESSAGE_SIZE}. */
  maxMessageSize?: number;
  /** The largest frame accepted on a port's stream (see `messageTargetOverStream`). */
  maxMessageBytes?: number;
  /** Default {@link DEFAULT_PORT_STREAM_LIMIT}. */
  maxInboundStreams?: number;
  /** Default {@link DEFAULT_PORT_STREAM_LIMIT}. */
  maxOutboundStreams?: number;
  runOnLimitedConnection?: boolean;
}

/** A `webrun-rpc` `PortMux` by shape; this package imports nothing from it. */
export interface Libp2pPortMux {
  openPort(meta?: unknown, options?: { signal?: AbortSignal }): Promise<StreamPort>;
  close(reason?: unknown): Promise<void>;
  readonly maxMessageSize: number;
}

/**
 * Native MessagePorts over libp2p: every port is its own libp2p stream, which yamux multiplexes
 * with its own per-stream flow control, framed as messages by `messageTargetOverStream`. Hand it
 * to `webrun-rpc` as a port source and its stream tier runs one call per port, with its tested
 * backpressure — a producer stays one confirmed chunk ahead of its consumer — instead of
 * libp2p's own buffering, which lets a producer run tens of megabytes ahead of a consumer that
 * stopped reading:
 *
 * ```ts
 * const codec = { encode: serialize, decode: deserialize }; // webrun-msgpack
 * await serve({ mux: overPorts((onPort) => libp2pPortMux({ node, codec, onPort })) }, handler);
 * const { call } = await connect({ mux: overPorts(() => libp2pPortMux({ node, codec, peer })) });
 * ```
 *
 * Each port carries `closeSignal`, aborted when its stream ends or its peer goes, so a call on a
 * dead stream fails instead of waiting. Streams are opened through the same early-stream gate as
 * `connect()`. `meta` is not sent: the protocol says what a port is for.
 */
export async function libp2pPortMux(options: Libp2pPortMuxOptions): Promise<Libp2pPortMux> {
  const { node, peer, codec, onPort, maxMessageBytes, runOnLimitedConnection } = options;
  const maxInboundStreams = options.maxInboundStreams ?? DEFAULT_PORT_STREAM_LIMIT;
  const maxOutboundStreams = options.maxOutboundStreams ?? DEFAULT_PORT_STREAM_LIMIT;
  const protocol = options.protocol ?? DEFAULT_PORT_PROTOCOL;
  const maxMessageSize = options.maxMessageSize ?? DEFAULT_PORT_MAX_MESSAGE_SIZE;
  const live = new Set<StreamPort>();
  let closed = false;

  const wrap = (stream: Stream): StreamPort => {
    const { target: inner } = messageTargetOverStream(stream, { maxMessageBytes });
    const wrapped = new Map<Listener, Listener>();
    // closed here, or the stream ended: a port closed locally is closed at once, not when libp2p
    // finishes closing its stream
    const local = new AbortController();
    const port: StreamPort = {
      closeSignal: AbortSignal.any([inner.closeSignal, local.signal]),
      get bufferedAmount() {
        return inner.bufferedAmount;
      },
      whenDrained: () => inner.whenDrained(),
      postMessage(message: unknown) {
        inner.postMessage(codec.encode(message));
      },
      addEventListener(_type, listener) {
        if (wrapped.has(listener)) return;
        const decoding: Listener = (event) => {
          let data: unknown;
          try {
            data = codec.decode(event.data as Uint8Array);
          } catch (err) {
            // a peer speaking another codec, or a corrupt frame: fail the port, as a malformed
            // frame fails the stream, rather than drop the message and leave its call waiting
            stream.abort(
              new Error("webrun-streams-libp2p: a frame the port's codec cannot decode", {
                cause: err,
              }),
            );
            return;
          }
          return listener(new MessageEvent("message", { data }));
        };
        wrapped.set(listener, decoding);
        inner.addEventListener("message", decoding);
      },
      removeEventListener(_type, listener) {
        const decoding = wrapped.get(listener);
        if (!decoding) return;
        wrapped.delete(listener);
        inner.removeEventListener("message", decoding);
      },
      async close() {
        live.delete(port);
        if (!local.signal.aborted) local.abort(new Error("webrun-streams-libp2p: port closed"));
        await inner.close();
      },
    };
    live.add(port);
    inner.closeSignal.addEventListener("abort", () => live.delete(port), { once: true });
    return port;
  };

  let handled = false;
  if (onPort) {
    const handleOptions: StreamHandlerOptions = { maxInboundStreams, maxOutboundStreams };
    if (runOnLimitedConnection !== undefined)
      handleOptions.runOnLimitedConnection = runOnLimitedConnection;
    await node.handle(
      protocol,
      (stream: Stream, connection: Connection) => {
        if (closed) {
          stream.abort(new Error("webrun-streams-libp2p: port mux closed"));
          return;
        }
        // The port is wrapped and handed over in this tick: `messageTargetOverStream` starts
        // reading at once, and a message with no listener yet would be dropped.
        const port = wrap(stream);
        let accepted = false;
        try {
          accepted = onPort(port, { remotePeer: connection.remotePeer, connection }) !== false;
        } catch {
          accepted = false;
        }
        if (!accepted) {
          live.delete(port);
          stream.abort(new Error("webrun-streams-libp2p: port refused"));
        }
      },
      handleOptions,
    );
    handled = true;
  }

  const dialOptions: DialProtocolOptions = { maxOutboundStreams };
  if (runOnLimitedConnection !== undefined)
    dialOptions.runOnLimitedConnection = runOnLimitedConnection;

  return {
    maxMessageSize,
    async openPort(_meta, opts) {
      if (closed) throw new Error("webrun-streams-libp2p: port mux closed");
      if (!peer) throw new Error("webrun-streams-libp2p: openPort needs `peer`");
      const stream = await openGatedStream(node, peer, protocol, {
        ...dialOptions,
        signal: opts?.signal,
      });
      if (closed) {
        await closeStream(stream);
        throw new Error("webrun-streams-libp2p: port mux closed");
      }
      const port = wrap(stream);
      const signal = opts?.signal;
      if (signal) {
        const onAbort = () => void port.close();
        signal.addEventListener("abort", onAbort, { once: true });
        // the caller's signal may outlive many ports: let go of this one when it closes
        port.closeSignal.addEventListener(
          "abort",
          () => signal.removeEventListener("abort", onAbort),
          { once: true },
        );
      }
      return port;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (handled) await node.unhandle(protocol).catch(() => undefined);
      await Promise.allSettled([...live].map((p) => p.close()));
    },
  };
}
