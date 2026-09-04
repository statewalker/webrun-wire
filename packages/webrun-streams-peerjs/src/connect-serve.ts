import {
  type Connect,
  type Duplex,
  type EmulateMuxOptions,
  emulateMux,
  type Serve,
} from "@statewalker/webrun-streams";
import type { DataConnection, Peer } from "peerjs";
import { byteChannelFromPeerJs } from "./byte-channel.js";

export interface ConnectPeerJsParams {
  /** Already-open `DataConnection` with `serialization: "raw"`. */
  conn: DataConnection;
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
}

export interface ServePeerJsParams {
  /** Connected `Peer`. The adapter listens for inbound `DataConnection`s. */
  peer: Peer;
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
}

export const connect: Connect<ConnectPeerJsParams> = async ({ conn, mux: muxOpts }) => {
  const channel = byteChannelFromPeerJs(conn);
  const mux = emulateMux(channel, { ...muxOpts, side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<ServePeerJsParams> = async ({ peer, mux: muxOpts }, handler: Duplex) => {
  const muxes: Array<{ close: () => Promise<void> }> = [];

  const onConnection = (conn: DataConnection): void => {
    const ready = (): void => {
      const channel = byteChannelFromPeerJs(conn);
      const mux = emulateMux(channel, { ...muxOpts, side: "responder" });
      mux.serve(handler);
      muxes.push(mux);
      void channel.closed.then(() => mux.close());
    };
    if (conn.open) ready();
    else conn.on("open", ready);
  };
  peer.on("connection", onConnection);

  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    peer.off("connection", onConnection);
    await Promise.all(muxes.map((m) => m.close()));
  };
};
