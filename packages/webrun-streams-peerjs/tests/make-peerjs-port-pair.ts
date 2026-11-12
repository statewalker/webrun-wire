import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import type { DataConnection } from "peerjs";
import { Peer } from "peerjs";
import { inject } from "vitest";
import { messageTargetOverPeerJs } from "../src/message-target.js";
import { waitConnOpen, waitPeerOpen } from "./make-peerjs-pair.js";

/**
 * The port stack over PeerJS: each `DataConnection` is one pipe of bytes
 * (`messageTargetOverPeerJs`, reporting a 16 KiB-safe `maxMessageSize`),
 * `overPipe` with `msgpackCodec` invents the ports, and `webrun-rpc`'s
 * `connect` / `serve` run one call per port. L6's 256 KiB body therefore
 * crosses as chunks under the data channel's cross-browser frame limit.
 *
 * `PairTuning.maxMessageSize`, when smaller than the adapter's own ceiling, is used instead.
 * L6 (spec D17): this stack withholds a chunk's confirmation until the consumer has pulled past
 * it, so a producer is never more than a chunk ahead; the pair declares 8 KiB (two 4 KiB chunks).
 */
export const makePeerJsPortPair: MakePair = async (tuning) => {
  const fit = (own: number) => Math.min(own, tuning?.maxMessageSize ?? own);
  const port = inject("peerServerPort");
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const responderId = `webrun-port-responder-${suffix}`;
  const options = { host: "127.0.0.1", port, path: "/webrun", secure: false, debug: 0 };
  const responderPeer = new Peer(responderId, options);
  const callerPeer = new Peer(`webrun-port-caller-${suffix}`, options);
  try {
    await Promise.all([
      waitPeerOpen(responderPeer, "responder"),
      waitPeerOpen(callerPeer, "caller"),
    ]);
  } catch (err) {
    responderPeer.destroy();
    callerPeer.destroy();
    throw err;
  }
  return {
    runAheadBytes: 8192,
    async connect() {
      const conn = callerPeer.connect(responderId, { serialization: "raw", reliable: true });
      await waitConnOpen(conn);
      const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
      return connect({
        mux: overPipe(target, {
          codec: msgpackCodec,
          side: "initiator",
          signal,
          maxMessageSize: fit(maxMessageSize),
        }),
      });
    },
    async serve(handler) {
      const teardowns = new Set<() => Promise<void>>();
      const onConnection = (conn: DataConnection): void => {
        const ready = (): void => {
          const { target, signal, maxMessageSize } = messageTargetOverPeerJs(conn);
          void serve(
            {
              mux: overPipe(target, {
                codec: msgpackCodec,
                side: "responder",
                signal,
                maxMessageSize,
              }),
            },
            handler,
          ).then((teardown) => {
            teardowns.add(teardown);
            signal.addEventListener("abort", () => teardowns.delete(teardown), { once: true });
          });
        };
        if (conn.open) ready();
        else conn.on("open", ready);
      };
      responderPeer.on("connection", onConnection);
      return async () => {
        responderPeer.off("connection", onConnection);
        for (const teardown of [...teardowns]) await teardown();
      };
    },
    async close() {
      callerPeer.destroy();
      responderPeer.destroy();
    },
  };
};
