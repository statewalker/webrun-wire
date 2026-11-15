import {
  type NativeChannel,
  type NativePortMuxControl,
  newMessagePipe,
  newNativePortMux,
  type ValueCodec,
} from "@statewalker/webrun-streams";
import { describePortWindow, type PortWindows } from "../src/index.js";

/** Two byte pipes wired to each other, delivering on a later task, in order. */
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
 * How a transport tells the two ends that both speak the window: `"open"`
 * when the channel's open settles it for both (a libp2p protocol id), or
 * `"hello"` when only the responder learns it at open and the opener waits
 * for its answer (a WebRTC data channel's `protocol`).
 */
type Negotiation = "open" | "hello";

function memoryHarness(negotiation: Negotiation) {
  return async (codec: ValueCodec, windows: PortWindows) => {
    let server: NativePortMuxControl | undefined;
    const both = windows.opener !== undefined && windows.server !== undefined;
    const opener = newNativePortMux({
      name: "memory",
      codec,
      maxMessageSize: 1024,
      window: windows.opener,
      open: async (signal) => {
        signal?.throwIfAborted();
        const [near, far] = channelPair();
        const target = server;
        setTimeout(() => {
          if (target) target.accept({ ...far, window: both ? "agreed" : undefined }, {});
          else void far.pipe.close();
        }, 0);
        const offered = windows.opener !== undefined;
        return {
          ...near,
          window:
            negotiation === "open"
              ? both
                ? "agreed"
                : undefined
              : offered
                ? "offered"
                : undefined,
        };
      },
    });
    return {
      opener: opener.mux,
      async serve(onPort: Parameters<typeof newNativePortMux>[0]["onPort"]) {
        server = newNativePortMux({
          name: "memory",
          codec,
          maxMessageSize: 1024,
          window: windows.server,
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
  };
}

describePortWindow("newNativePortMux (in memory, agreed at open)", memoryHarness("open"));
describePortWindow("newNativePortMux (in memory, the responder's hello)", memoryHarness("hello"));
