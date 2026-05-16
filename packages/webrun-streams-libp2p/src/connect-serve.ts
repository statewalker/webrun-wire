import type { Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import { duplexOverStream } from "./duplex-over-stream.js";

export const DEFAULT_PROTOCOL = "/webrun-streams/1.0.0";

export interface ConnectLibp2pParams {
  node: Libp2p;
  peer: PeerId | Multiaddr;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
}

export interface ServeLibp2pParams {
  node: Libp2p;
  /** libp2p protocol id; defaults to `/webrun-streams/1.0.0`. */
  protocol?: string;
}

/**
 * Caller-side: each `call(input)` opens a new libp2p `Stream` via
 * `node.dialProtocol(peer, [protocol])` and runs the call over it.
 */
export const connect: Connect<ConnectLibp2pParams> = async ({ node, peer, protocol }) => {
  const proto = protocol ?? DEFAULT_PROTOCOL;
  const open = new Set<Stream>();
  const call: Duplex = (input) => {
    let streamRef: Stream | null = null;
    const gen = (async function* () {
      const stream = (await (
        node as unknown as {
          dialProtocol(p: PeerId | Multiaddr, protocols: string[]): Promise<Stream>;
        }
      ).dialProtocol(peer, [proto])) as Stream;
      streamRef = stream;
      open.add(stream);
      let sourceCompleted = false;
      try {
        yield* duplexOverStream(stream, input, {
          onSourceCompleted: () => {
            sourceCompleted = true;
          },
        });
      } finally {
        open.delete(stream);
        if (sourceCompleted) {
          // Natural end on both sides. Graceful close.
          try {
            await stream.close();
          } catch {
            /* ignore */
          }
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
 * wrapped as a `Duplex` and handed to `handler`.
 */
export const serve: Serve<ServeLibp2pParams> = async ({ node, protocol }, handler: Duplex) => {
  const proto = protocol ?? DEFAULT_PROTOCOL;
  const onStream = (data: { stream: Stream }): void => {
    void (async () => {
      const stream = data.stream;
      const inputQueue = makeInputQueue();
      // Hand the handler an input queue we control. Signal end-of-input as
      // soon as the peer's source ends — without this, the handler would hang
      // forever waiting for input that never arrives.
      const output = handler(inputQueue.iter());
      try {
        for await (const chunk of duplexOverStream(stream, output, {
          onPeerInputEnd: (err) => inputQueue.done(err),
        })) {
          inputQueue.push(chunk);
        }
      } finally {
        inputQueue.done();
        try {
          await stream.close();
        } catch {
          /* ignore */
        }
      }
    })();
  };
  await (
    node as unknown as {
      handle(p: string, cb: (data: { stream: Stream }) => void): Promise<void>;
    }
  ).handle(proto, onStream);

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    await (node as unknown as { unhandle(p: string): Promise<void> }).unhandle(proto);
  };
};

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
