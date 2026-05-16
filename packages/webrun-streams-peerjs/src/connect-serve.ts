import { type Connect, type Duplex, emulateMux, type Serve } from "@statewalker/webrun-streams";
import type { DataConnection, Peer } from "peerjs";
import { byteChannelFromPeerJs } from "./byte-channel.js";

export interface ConnectPeerJsParams {
  /** Already-open `DataConnection` with `serialization: "raw"`. */
  conn: DataConnection;
}

export interface ServePeerJsParams {
  /** Connected `Peer`. The adapter listens for inbound `DataConnection`s. */
  peer: Peer;
}

export const connect: Connect<ConnectPeerJsParams> = async ({ conn }) => {
  const channel = byteChannelFromPeerJs(conn);
  const mux = emulateMux(channel, { side: "initiator" });
  return {
    call: mux.call,
    async close() {
      await mux.close();
    },
  };
};

export const serve: Serve<ServePeerJsParams> = async ({ peer }, handler: Duplex) => {
  const muxes: Array<{ close: () => Promise<void> }> = [];

  const onConnection = (conn: DataConnection): void => {
    const ready = (): void => {
      const channel = byteChannelFromPeerJs(conn);
      const mux = emulateMux(channel, { side: "responder" });
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
