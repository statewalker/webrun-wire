import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { connect, overPipe, serve } from "@statewalker/webrun-rpc";
import { collectBytes } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_MESSAGE_SIZE, messageTargetOverByteChannel } from "../src/message-target.js";
import type { ByteChannel } from "../src/types.js";

/** Two in-memory ByteChannels wired to each other, delivering on a later task. */
function channelPair(): [ByteChannel, ByteChannel] {
  const make = () => {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });
    return {
      push(b: Uint8Array) {
        queue.push(b);
        wake?.();
      },
      end() {
        done = true;
        wake?.();
        resolveClosed();
      },
      recv: (async function* () {
        for (;;) {
          while (queue.length) yield queue.shift() as Uint8Array;
          if (done) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      })(),
      closed,
    };
  };
  const ia = make();
  const ib = make();
  const channel = (self: typeof ia, peer: typeof ia): ByteChannel => ({
    send: (bytes) => {
      const copy = bytes.slice();
      setTimeout(() => peer.push(copy), 0);
    },
    recv: self.recv,
    closed: self.closed,
    close: () => {
      self.end();
      peer.end();
    },
  });
  return [channel(ia, ib), channel(ib, ia)];
}

describe("messageTargetOverByteChannel", () => {
  it("carries the port stack: a call round-trips a body many times maxMessageSize", async () => {
    const [ca, cb] = channelPair();
    const b = messageTargetOverByteChannel(cb);
    await serve(
      {
        mux: overPipe(b.target, {
          codec: msgpackCodec,
          side: "responder",
          signal: b.signal,
          maxMessageSize: b.maxMessageSize,
        }),
      },
      async function* echo(input) {
        for await (const chunk of input) yield chunk;
      },
    );
    const a = messageTargetOverByteChannel(ca);
    const { call, close } = await connect({
      mux: overPipe(a.target, {
        codec: msgpackCodec,
        side: "initiator",
        signal: a.signal,
        maxMessageSize: a.maxMessageSize,
      }),
    });
    const body = new Uint8Array(200_000).map((_, i) => i & 0xff);
    const back = await collectBytes(call([body]));
    expect(back).toEqual(body);
    await close();
  });

  it("reports a data channel's safe payload ceiling, overridable", () => {
    const [ca] = channelPair();
    expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(16 * 1024 - 256);
    expect(messageTargetOverByteChannel(ca).maxMessageSize).toBe(DEFAULT_MAX_MESSAGE_SIZE);
    expect(messageTargetOverByteChannel(ca, { maxMessageSize: 1000 }).maxMessageSize).toBe(1000);
  });

  it("aborts its signal when the channel closes; posting after is a no-op; non-bytes are refused", async () => {
    const [ca, cb] = channelPair();
    const a = messageTargetOverByteChannel(ca);
    expect(() => a.target.postMessage({ x: 1 })).toThrow(TypeError);
    cb.close();
    await new Promise<void>((r) =>
      a.signal.aborted ? r() : a.signal.addEventListener("abort", () => r(), { once: true }),
    );
    expect(() => a.target.postMessage(new Uint8Array([1]))).not.toThrow();
  });

  it("close() closes the channel and aborts the signal", async () => {
    const [ca, cb] = channelPair();
    const a = messageTargetOverByteChannel(ca);
    const b = messageTargetOverByteChannel(cb);
    await a.target.close();
    expect(a.signal.aborted).toBe(true);
    await new Promise<void>((r) =>
      b.signal.aborted ? r() : b.signal.addEventListener("abort", () => r(), { once: true }),
    );
  });
});
