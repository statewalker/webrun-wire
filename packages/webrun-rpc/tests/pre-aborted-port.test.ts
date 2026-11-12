import { collectBytes } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { duplexOverPort, type MessageTarget, serveDuplexOverPort } from "../src/index.js";

/** A port whose transport is already gone when the stream tier gets it. */
const deadPort = (): MessageTarget => {
  const life = new AbortController();
  life.abort(new Error("the stream was reset before it was handed over"));
  return {
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    closeSignal: life.signal,
  };
};
const within = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung")), ms))]);

describe("(review of #110) a port closed before the stream tier gets it", () => {
  it("a call on it fails at once instead of waiting for ever", async () => {
    const failure = await within(collectBytes(duplexOverPort(deadPort())([new Uint8Array([1])]))).catch(
      (e) => e as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toBe("hung");
  });

  it("serving on it ends the handler instead of leaving it waiting for input", async () => {
    let ended!: () => void;
    const done = new Promise<void>((r) => {
      ended = r;
    });
    serveDuplexOverPort(deadPort(), (input) =>
      (async function* () {
        try {
          for await (const _ of input);
        } finally {
          ended();
        }
        yield new Uint8Array(0);
      })(),
    );
    await within(done);
  });
});
