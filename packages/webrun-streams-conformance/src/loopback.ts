import type { Duplex } from "@statewalker/webrun-streams";

/**
 * The shape every adapter test factory returns. The suite drives `connect`
 * for each test case and uses `serve` to register the handler.
 */
export interface ConnectServePair {
  connect(): Promise<{ call: Duplex; close: () => Promise<void> }>;
  serve(handler: Duplex): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/**
 * Flow-control tuning L6 asks a pair for. No remaining adapter has the credit
 * window these describe (it was `emulateMux`'s, removed in Plan C3): every pair
 * ignores them and L6 is an integrity check, until spec D17 redefines it.
 */
export interface PairTuning {
  mtu?: number;
  maxStreamBuffer?: number;
}

export type MakePair = (tuning?: PairTuning) => Promise<ConnectServePair>;

/**
 * Loopback pair: `call` invokes the registered `handler` directly, no
 * transport. The conformance suite must pass against this — it self-validates
 * that the assertions are correctly formulated independent of any wire
 * protocol or multiplexer.
 */
export const makeLoopbackPair: MakePair = async () => {
  let handler: Duplex | null = null;
  let closed = false;

  const call: Duplex = (input) => {
    if (closed) {
      return (async function* () {
        if ((0 as number) === 0) throw new Error("loopback: pair closed");
        yield new Uint8Array(0);
      })();
    }
    if (!handler) {
      return (async function* () {
        if ((0 as number) === 0) throw new Error("loopback: no handler registered");
        yield new Uint8Array(0);
      })();
    }
    return handler(input);
  };

  return {
    async connect() {
      return {
        call,
        async close() {
          /* no-op for loopback; pair.close handles teardown */
        },
      };
    },
    async serve(h) {
      handler = h;
      return async () => {
        if (handler === h) handler = null;
      };
    },
    async close() {
      closed = true;
      handler = null;
    },
  };
};
