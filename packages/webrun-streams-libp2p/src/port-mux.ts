import type {
  Connection,
  DialProtocolOptions,
  Libp2p,
  PeerId,
  Stream,
  StreamHandlerOptions,
} from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import {
  type NativeChannel,
  type NativePort,
  newNativePortMux,
  type ValueCodec,
} from "@statewalker/webrun-streams";
import { messageTargetOverStream } from "./message-target-over-stream.js";
import { openGatedStream } from "./stream-gate.js";

export type { ValueCodec };

/** The protocol a port's stream negotiates unless told otherwise. */
export const DEFAULT_PORT_PROTOCOL = "/webrun-ports/1.0.0";

/**
 * The protocol a windowed port's stream negotiates, for a mux whose ports
 * negotiate `protocol`: `protocol` with `/window` appended. A mux with
 * `window` dials it first and falls back to `protocol`, and serves both.
 */
export function windowProtocolOf(protocol: string): string {
  return `${protocol}/window`;
}

/**
 * 256 KiB: what one message on a port may carry before `webrun-rpc`'s stream tier chunks a body.
 * A port waits for each chunk's confirmation, so a larger chunk means fewer round trips; well
 * under `messageTargetOverStream`'s 64 MiB frame ceiling.
 */
export const DEFAULT_PORT_MAX_MESSAGE_SIZE = 256 * 1024;

/**
 * The stream limits a port mux asks libp2p for unless told otherwise: every concurrent call is a
 * stream, and libp2p's own default (32 per protocol) would reset the 33rd.
 */
export const DEFAULT_PORT_STREAM_LIMIT = 1024;

/**
 * One port: a libp2p stream as a `MessageTarget` of values, with its close signal on it. Built by
 * the shared native port lifecycle (`newNativePortMux` in `@statewalker/webrun-streams`).
 */
export type StreamPort = NativePort;

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
  /**
   * Per-port flow control, in bytes (off when unset; from 64 KiB,
   * `MIN_PORT_WINDOW` in `@statewalker/webrun-streams`): the most this end holds of a port's messages
   * delivered and not yet consumed (statewalker/webrun-wire#153). A port
   * whose two ends both set it negotiates {@link windowProtocolOf} `protocol`,
   * and `webrun-rpc`'s stream tier then pipelines its chunks, up to the
   * peer's window in flight, instead of waiting for each chunk's
   * confirmation; against a mux without it (an older peer) the port
   * negotiates `protocol` and runs as before. 1-4 MiB is a reasonable range:
   * the most one call moves per round trip, and the most a producer runs
   * ahead of a consumer that stopped reading.
   */
  window?: number;
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
  // Checked by the shared lifecycle, before the protocols are handled.
  const { window } = options;
  const windowProtocol = windowProtocolOf(protocol);

  /**
   * A stream as a channel: framed bytes, and a reset to break it off (the peer hears it). The
   * protocol it negotiated says whether both ends run the window.
   */
  const channelOf = (stream: Stream): NativeChannel => ({
    pipe: messageTargetOverStream(stream, { maxMessageBytes }).target,
    fail: (reason) => stream.abort(reason),
    ...(window !== undefined && stream.protocol === windowProtocol
      ? { window: "agreed" as const }
      : {}),
  });

  const dialOptions: DialProtocolOptions = { maxOutboundStreams };
  if (runOnLimitedConnection !== undefined)
    dialOptions.runOnLimitedConnection = runOnLimitedConnection;

  let handled = false;
  const control = newNativePortMux<InboundPortInfo>({
    name: "webrun-streams-libp2p",
    codec,
    maxMessageSize,
    onPort,
    window,
    async open(signal) {
      if (!peer) throw new Error("webrun-streams-libp2p: openPort needs `peer`");
      const protocols = window !== undefined ? [windowProtocol, protocol] : protocol;
      const stream = await openGatedStream(node, peer, protocols, { ...dialOptions, signal });
      return channelOf(stream);
    },
    async stopAccepting() {
      if (!handled) return;
      const served = window !== undefined ? [protocol, windowProtocol] : [protocol];
      await node.unhandle(served).catch(() => undefined);
    },
  });

  if (onPort) {
    const handleOptions: StreamHandlerOptions = { maxInboundStreams, maxOutboundStreams };
    if (runOnLimitedConnection !== undefined)
      handleOptions.runOnLimitedConnection = runOnLimitedConnection;
    const served = window !== undefined ? [protocol, windowProtocol] : [protocol];
    await node.handle(
      served,
      (stream: Stream, connection: Connection) => {
        if (control.closed) {
          stream.abort(new Error("webrun-streams-libp2p: port mux closed"));
          return;
        }
        // The port is built in this tick: `messageTargetOverStream` starts reading at once.
        control.accept(channelOf(stream), { remotePeer: connection.remotePeer, connection });
      },
      handleOptions,
    );
    handled = true;
  }

  return control.mux as Libp2pPortMux;
}
