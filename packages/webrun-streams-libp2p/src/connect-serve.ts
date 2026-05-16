import type { Multiaddr } from "@multiformats/multiaddr";
import type { Libp2p, PeerId, Stream } from "@libp2p/interface";
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
    return (async function* () {
      const stream = (await (
        node as unknown as {
          dialProtocol(p: PeerId | Multiaddr, protocols: string[]): Promise<Stream>;
        }
      ).dialProtocol(peer, [proto])) as Stream;
      open.add(stream);
      try {
        yield* duplexOverStream(stream, input);
      } finally {
        open.delete(stream);
      }
    })();
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
      const output = handler(inputQueue.iter());
      for await (const chunk of duplexOverStream(stream, output)) {
        inputQueue.push(chunk);
      }
      inputQueue.done();
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

function makeInputQueue(): {
  iter(): AsyncGenerator<Uint8Array>;
  push(chunk: Uint8Array): void;
  done(): void;
} {
  const slots: Array<{ type: "value"; value: Uint8Array } | { type: "done" }> = [];
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
            const s = slots.shift();
            if (!s) continue;
            if (s.type === "done") return;
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
    done(): void {
      if (closed) return;
      slots.push({ type: "done" });
      wake?.();
    },
  };
}
