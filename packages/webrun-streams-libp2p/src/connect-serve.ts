import type { Connection, Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import { closeStream, duplexOverStream } from "./duplex-over-stream.js";

export const DEFAULT_PROTOCOL = "/webrun-streams/1.0.0";

export interface ConnectLibp2pParams {
  node: Libp2p;
  peer: PeerId | Multiaddr;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
  /**
   * How long to wait for a backpressured stream to drain before dropping the
   * peer; defaults to `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes).
   */
  drainTimeoutMs?: number;
}

export interface ServeLibp2pParams {
  node: Libp2p;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
  /**
   * How long to wait for a backpressured stream to drain before dropping the
   * peer; defaults to `DEFAULT_DRAIN_TIMEOUT_MS` (5 minutes). This is the only
   * bound on a peer that requests something and then stops reading without
   * closing, since the caller-side `.return`/abort escape does not exist here.
   */
  drainTimeoutMs?: number;
}

/**
 * Caller-side: each `call(input)` opens a new libp2p `Stream` via
 * `node.dialProtocol(peer, [protocol])` and runs the call over it.
 */
export const connect: Connect<ConnectLibp2pParams> = async ({
  node,
  peer,
  protocol,
  drainTimeoutMs,
}) => {
  const proto = protocol ?? DEFAULT_PROTOCOL;
  const open = new Set<Stream>();
  const call: Duplex = (input) => {
    let streamRef: Stream | null = null;
    const gen = (async function* () {
      const stream = await node.dialProtocol(peer, [proto]);
      streamRef = stream;
      open.add(stream);
      let sourceCompleted = false;
      try {
        yield* duplexOverStream(stream, input, {
          drainTimeoutMs,
          onSourceCompleted: () => {
            sourceCompleted = true;
          },
        });
      } finally {
        open.delete(stream);
        if (sourceCompleted) {
          // Natural end on both sides. Graceful close, bounded so a peer
          // that stops reading without resetting can't hang this forever.
          await closeStream(stream);
        }
        // Else: consumer cancelled. The .return override below has already
        // called stream.abort to send RST; nothing more to do here.
      }
    })();

    // Send a yamux RST to peer when the consumer cancels (i.e., calls .return
    // on this generator). Doing it here is essential because by the time the
    // generator's own finally runs, the for-await teardown chain has already
    // marked the stream's status as `closed` — and AbstractStream.abort is a
    // no-op on closed streams.
    const origReturn = gen.return.bind(gen);
    gen.return = async (value: unknown) => {
      if (streamRef) {
        try {
          streamRef.abort(new Error("call cancelled"));
        } catch {
          /* ignore */
        }
      }
      return origReturn(value as undefined);
    };

    return gen;
  };
  return {
    call,
    async close() {
      for (const s of open) {
        try {
          s.abort(new Error("connection close"));
        } catch {
          /* ignore */
        }
      }
    },
  };
};

/**
 * Server-side: registers `node.handle(protocol, ...)`. Each inbound stream is
 * wrapped as a `Duplex` and handed to `handler`. Identity-unaware; use
 * `serveConnections` when the handler needs to know who is calling.
 */
export const serve: Serve<ServeLibp2pParams> = async (params, handler: Duplex) =>
  serveConnections(params, () => handler);

/** What the serving side knows about the connection a stream arrived on. */
export interface ConnectionContext {
  /**
   * The peer id libp2p's Noise handshake proved for this connection. This is
   * the only identity claim on the serving side that cannot be forged by the
   * request payload.
   */
  remotePeer: PeerId;
}

/**
 * Builds a handler for one inbound connection. Called once per stream, so the
 * connection stays reachable in the returned Duplex's closure — `Duplex` is
 * bytes-only (ADR-0004) and gains no new parameter.
 */
export type ServeConnectionsHandler = (context: ConnectionContext) => Duplex;

/**
 * Like `serve`, but the handler is built per inbound stream and is told which
 * peer libp2p proved on that connection.
 */
export async function serveConnections(
  { node, protocol, drainTimeoutMs }: ServeLibp2pParams,
  makeHandler: ServeConnectionsHandler,
): Promise<() => Promise<void>> {
  const proto = protocol ?? DEFAULT_PROTOCOL;

  const onStream = (stream: Stream, connection: Connection): void => {
    void (async () => {
      const handler = makeHandler({ remotePeer: connection.remotePeer });
      const inputQueue = makeInputQueue();
      const output = handler(inputQueue.iter());
      try {
        for await (const chunk of duplexOverStream(stream, output, {
          drainTimeoutMs,
          onPeerInputEnd: (err) => inputQueue.done(err),
        })) {
          inputQueue.push(chunk);
        }
      } finally {
        inputQueue.done();
        await closeStream(stream);
      }
    })().catch((err: unknown) => {
      // One inbound stream failing must not take down the process serving
      // every other peer. `duplexOverStream` rejects on the read side
      // whenever the peer sends an ERROR frame or resets mid-request — which
      // happens in ordinary use, not just under attack (a browser tab closed
      // mid-request resets its streams). Without this catch that rejection is
      // unhandled, and Node's default for `unhandledRejection` is to
      // terminate. Logged rather than rethrown, and never rethrown from here:
      // there is no caller left to receive it.
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[webrun-streams-libp2p] serve: inbound stream on protocol ${proto} failed: ${e.message}`,
        e,
      );
    });
  };

  await node.handle(proto, onStream);

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await node.unhandle(proto);
  };
}

interface InputQueue {
  iter(): AsyncGenerator<Uint8Array>;
  push(chunk: Uint8Array): void;
  done(err?: Error): void;
}

function makeInputQueue(): InputQueue {
  type Slot = { type: "value"; value: Uint8Array } | { type: "done"; err?: Error };
  const slots: Slot[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    iter(): AsyncGenerator<Uint8Array> {
      return (async function* () {
        try {
          while (true) {
            if (slots.length === 0) {
              await new Promise<void>((r) => {
                wake = r;
              });
              wake = null;
              continue;
            }
            const s = slots.shift() as Slot;
            if (s.type === "done") {
              if (s.err) throw s.err;
              return;
            }
            yield s.value;
          }
        } finally {
          closed = true;
        }
      })();
    },
    push(chunk: Uint8Array): void {
      if (closed) return;
      slots.push({ type: "value", value: chunk });
      wake?.();
    },
    done(err?: Error): void {
      if (closed) return;
      slots.push({ type: "done", err });
      wake?.();
    },
  };
}
