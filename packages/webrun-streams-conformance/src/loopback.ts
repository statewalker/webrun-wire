import type { Duplex } from "@statewalker/webrun-streams";

/**
 * The shape every adapter test factory returns. The suite drives `connect`
 * for each test case and uses `serve` to register the handler.
 */
export interface ConnectServePair {
  connect(): Promise<{ call: Duplex; close: () => Promise<void> }>;
  serve(handler: Duplex): Promise<() => Promise<void>>;
  close(): Promise<void>;
  /**
   * The most bytes a producer may get ahead of a consumer that has stopped
   * reading — this transport's buffering between the two ends. L6 asserts it,
   * in both directions (spec D17). Omitted, the pair claims no bound and L6
   * checks only that a stalled transfer completes once the consumer resumes;
   * the test title says so.
   */
  runAheadBytes?: number;
}

/**
 * What L6 asks of a pair (spec D17): bodies crossing as many messages. A pair
 * that can set its payload ceiling passes `maxMessageSize` on; one whose
 * transport decides ignores it.
 */
export interface PairTuning {
  maxMessageSize?: number;
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
    // `call` is the handler itself: a value is produced only when pulled.
    runAheadBytes: 0,
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
