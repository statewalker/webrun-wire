import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import type { Duplex, MessagePipe } from "@statewalker/webrun-streams";
import { describeDuplexAdapter, type MakePair } from "@statewalker/webrun-streams-conformance";
import { chromePortPipe } from "../src/index.js";
import { extensionConnection } from "./extension-stack.js";
import { fakeChromePortPair } from "./fake-chrome-port.js";

/**
 * A pair whose `connect` opens a new connection, as `chrome.runtime.connect`
 * does, and hands the far end to the served handler. `open` builds the two
 * pipes of one connection.
 *
 * L6 (spec D17): the stack withholds a chunk's confirmation until the consumer
 * has pulled past it; the pair declares one 4 KiB chunk.
 */
function makePair(
  open: (maxMessageSize?: number) => {
    client: MessagePipe;
    server: MessagePipe;
    close(): Promise<void>;
  },
): MakePair {
  return async (tuning) => {
    let handler: Duplex | undefined;
    const connections: Array<() => Promise<void>> = [];
    return {
      runAheadBytes: 4096,
      async connect() {
        const { client, server, close } = open(tuning?.maxMessageSize);
        if (!handler) throw new Error("no handler served");
        const teardown = await serve(
          { mux: overPipe(server.target, { codec: msgpackCodec, side: "responder" }) },
          handler,
        );
        const connection = await connect({
          mux: overPipe(client.target, { codec: msgpackCodec, side: "initiator" }),
        });
        const closeAll = async () => {
          await connection.close();
          await teardown();
          await close();
        };
        connections.push(closeAll);
        return { call: connection.call, close: closeAll };
      },
      async serve(h) {
        handler = h;
        return async () => {
          handler = undefined;
        };
      },
      async close() {
        for (const c of connections.splice(0)) await c();
      },
    };
  };
}

describeDuplexAdapter(
  "chromePortPipe over overPipe",
  makePair((maxMessageSize) => {
    const [a, b] = fakeChromePortPair();
    const client = chromePortPipe(a, { maxMessageSize });
    const server = chromePortPipe(b, { maxMessageSize });
    return {
      client,
      server,
      close: async () => {
        await client.target.close();
        await server.target.close();
      },
    };
  }),
);

describeDuplexAdapter(
  "page -> content script relay -> service worker",
  makePair((maxMessageSize) => {
    const c = extensionConnection({ maxMessageSize });
    return { client: c.page, server: c.worker, close: () => c.close() };
  }),
);
