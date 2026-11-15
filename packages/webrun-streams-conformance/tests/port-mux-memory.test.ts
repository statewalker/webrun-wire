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

import { describe, expect, it } from "vitest";

describe("newNativePortMux specifics (review of #182)", () => {
  it("close() while an openPort is still pending rejects it", async () => {
    const control = newNativePortMux({
      name: "memory",
      codec: { encode: () => new Uint8Array(0), decode: () => null },
      maxMessageSize: 1,
      // A channel that never opens on its own: only the signal ends the wait.
      open: (signal) =>
        new Promise<NativeChannel>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const pending = control.mux.openPort();
    await control.mux.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("a refused port is failed hard: the channel is not closed gracefully before (or instead of) failing", async () => {
    const calls: string[] = [];
    const [near] = channelPair();
    const pipe = near.pipe;
    const close = pipe.close.bind(pipe);
    const channel: NativeChannel = {
      pipe: Object.assign(Object.create(pipe), {
        close: async () => {
          calls.push("close");
          await close();
        },
      }),
      fail: () => {
        calls.push("fail");
      },
    };
    const control = newNativePortMux({
      name: "memory",
      codec: { encode: () => new Uint8Array(0), decode: () => null },
      maxMessageSize: 1,
      onPort: () => false,
      open: async () => channel,
    });
    control.accept(channel, {});
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toBe("fail");
    expect(calls).not.toContain("close");
  });
});

describe("newNativePortMux: a channel still opening (webrun-wire#182 follow-up)", () => {
  it("a message the peer sends before the channel is ready reaches the port", async () => {
    const [near, far] = channelPair();
    let markReady!: () => void;
    const ready = new Promise<void>((r) => {
      markReady = r;
    });
    const control = newNativePortMux({
      name: "memory",
      codec: {
        encode: (v) => new TextEncoder().encode(JSON.stringify(v)),
        decode: (b) => JSON.parse(new TextDecoder().decode(b)),
      },
      maxMessageSize: 1024,
      open: async () => ({ ...near, ready }),
    });
    let resolved = false;
    const opening = control.mux.openPort().then((p) => {
      resolved = true;
      return p;
    });
    // The peer answers at once, before this end's channel reports it is ready.
    far.pipe.postMessage(new TextEncoder().encode(JSON.stringify({ greeting: 1 })));
    await new Promise((r) => setTimeout(r, 10));
    // openPort waits for the channel to be ready...
    expect(resolved).toBe(false);
    markReady();
    const port = await opening;
    const got = await new Promise((r) => port.addEventListener("message", (e) => r(e.data)));
    expect(got).toEqual({ greeting: 1 });
  });

  it("a channel that fails before it is ready rejects openPort and leaves no port behind", async () => {
    const [near] = channelPair();
    const control = newNativePortMux({
      name: "memory",
      codec: { encode: () => new Uint8Array(0), decode: () => null },
      maxMessageSize: 1,
      open: async () => ({ ...near, ready: Promise.reject(new Error("never opened")) }),
    });
    await expect(control.mux.openPort()).rejects.toThrow(/never opened/);
  });
});

describe("newNativePortMux: closing while a channel opens (review of #183)", () => {
  const codec = { encode: () => new Uint8Array(0), decode: () => null };

  it("openPort then close() in the same tick: openPort rejects, and no rejection goes unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const [near] = channelPair();
      const control = newNativePortMux({
        name: "memory",
        codec,
        maxMessageSize: 1,
        // As webrtc's: `ready` rejects when the open signal aborts.
        open: async (signal) => ({
          ...near,
          ready: new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        }),
      });
      const pending = control.mux.openPort();
      const closing = control.mux.close();
      await expect(pending).rejects.toThrow(/closed/);
      await closing;
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a ready that ignores the signal: close() still rejects openPort rather than hand back a closed port", async () => {
    const [near] = channelPair();
    let markReady!: () => void;
    const control = newNativePortMux({
      name: "memory",
      codec,
      maxMessageSize: 1,
      open: async () => ({
        ...near,
        ready: new Promise<void>((r) => {
          markReady = r;
        }),
      }),
    });
    const pending = control.mux.openPort();
    await new Promise((r) => setTimeout(r, 5));
    await control.mux.close();
    await expect(pending).rejects.toThrow(/closed/);
    markReady();
  });
});
