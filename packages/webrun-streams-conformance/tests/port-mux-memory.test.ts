import {
  type NativeChannel,
  type NativePortMuxControl,
  newMessagePipe,
  newNativePortMux,
  type ValueCodec,
} from "@statewalker/webrun-streams";
import { describePortMux } from "../src/index.js";

/**
 * Two byte pipes wired to each other, delivering on a later task. Closing (or
 * failing) one end ends both, as a transport channel does.
 */
function channelPair(): [NativeChannel, NativeChannel] {
  let a!: ReturnType<typeof newMessagePipe>;
  let b!: ReturnType<typeof newMessagePipe>;
  const link = (peer: () => ReturnType<typeof newMessagePipe>) =>
    newMessagePipe(
      {
        send: (bytes) => {
          const copy = bytes.slice();
          setTimeout(() => peer().deliver(copy), 0);
        },
        close: () => {
          setTimeout(() => peer().end(new Error("memory: the peer closed the channel")), 0);
        },
      },
      { name: "memory" },
    );
  a = link(() => b);
  b = link(() => a);
  return [{ pipe: a.pipe.target }, { pipe: b.pipe.target }];
}

/**
 * The native port lifecycle over an in-memory transport: each `openPort`
 * makes a channel pair and hands the far end to the serving mux.
 */
async function memoryHarness(codec: ValueCodec) {
  let server: NativePortMuxControl | undefined;
  const opener = newNativePortMux({
    name: "memory",
    codec,
    maxMessageSize: 1024,
    open: async (signal) => {
      signal?.throwIfAborted();
      const [near, far] = channelPair();
      const target = server;
      setTimeout(() => {
        if (target) target.accept(far, {});
        else void far.pipe.close();
      }, 0);
      return near;
    },
  });
  return {
    opener: opener.mux,
    async serve(onPort: Parameters<typeof newNativePortMux>[0]["onPort"]) {
      server = newNativePortMux({
        name: "memory",
        codec,
        maxMessageSize: 1024,
        onPort,
        open: async () => {
          throw new Error("memory: the serving end opens no ports here");
        },
      });
      return server.mux;
    },
    async dispose() {
      await server?.mux.close();
    },
  };
}

describePortMux("newNativePortMux (in memory)", memoryHarness);
