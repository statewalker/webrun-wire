import { describe, expect, it } from "vitest";
import { overPipe, structuredCodec } from "../src/index.js";
import type { MessageTarget } from "../src/message-target.js";

// statewalker/webrun-wire#151: a pipe that carries its own life and payload
// ceiling (`closeSignal`, `maxMessageSize`, as every `webrun-streams-*`
// adapter's target now does) is ready for the port stack on its own:
// `overPipe(target, { codec, side })` needs no `signal` or `maxMessageSize`.

function pipeWith(extra: { closeSignal?: AbortSignal; maxMessageSize?: number }): MessageTarget {
  const { port1 } = new MessageChannel();
  return Object.assign(port1, extra) as unknown as MessageTarget;
}

describe("overPipe takes the pipe's own life and ceiling", () => {
  it("reports the pipe's maxMessageSize when none is given", async () => {
    const mux = await overPipe(pipeWith({ maxMessageSize: 1234 }), { codec: structuredCodec })();
    expect(mux.maxMessageSize).toBe(1234);
    await mux.close();
  });

  it("an explicit maxMessageSize wins", async () => {
    const mux = await overPipe(pipeWith({ maxMessageSize: 1234 }), {
      codec: structuredCodec,
      maxMessageSize: 99,
    })();
    expect(mux.maxMessageSize).toBe(99);
    await mux.close();
  });

  it("closes when the pipe's closeSignal aborts, without a signal option", async () => {
    const life = new AbortController();
    const mux = await overPipe(pipeWith({ closeSignal: life.signal }), {
      codec: structuredCodec,
    })();
    life.abort(new Error("the transport went away"));
    await expect(mux.openPort()).rejects.toThrow(/closed/);
  });
});
