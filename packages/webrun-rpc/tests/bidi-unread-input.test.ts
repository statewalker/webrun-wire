import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as v010 from "webrun-rpc-0-10";
import { callBidi } from "../src/call-bidi.js";
import { ioHandle } from "../src/io-handle.js";
import { ioSend } from "../src/io-send.js";
import { listenBidi } from "../src/listen-bidi.js";

// A handler that stops before reading all of its input: its side stops
// listening for chunks, so the caller's remaining chunk calls (and its closing
// `{ done: true }`) are never answered. With the stream tier's NO_TIMEOUT
// chunk calls the caller must still end promptly, not after a timeout and not
// never.

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

const PROMPT_MS = 500; // well under the old 1 s chunk deadline

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

async function withDeadline<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const neverReads = async (_input: AsyncIterable<number>) =>
  (async function* () {
    yield 10;
    yield 20;
  })();

const readsOneThenBreaks = async (input: AsyncIterable<number>) =>
  (async function* () {
    for await (const v of input) {
      yield v * 10;
      break;
    }
    yield 20;
  })();

const slowInput = async function* () {
  for (let i = 1; i <= 3; i++) {
    yield i;
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("a handler that does not read all of its input", () => {
  for (const [name, handler] of [
    ["never reads its input", neverReads],
    ["reads one item then breaks", readsOneThenBreaks],
  ] as const) {
    for (const [inputName, makeInput] of [
      ["an array", () => [1, 2, 3]],
      ["a slow generator", slowInput],
    ] as const) {
      it(`callBidi ends promptly when the handler ${name} (${inputName})`, async () => {
        const { port1, port2 } = newChannel();
        const close = listenBidi<number, number>(port2, handler);
        try {
          const got: number[] = [];
          await withDeadline(
            (async () => {
              for await (const v of callBidi<number, number>(port1, makeInput())) got.push(v);
            })(),
            PROMPT_MS,
          );
          expect(got).toEqual([10, 20]);
          await new Promise((r) => setTimeout(r, 20));
          expect(unhandled).toEqual([]);
        } finally {
          close();
          port1.close();
          port2.close();
        }
      });

      it(`ioSend ends promptly when ioHandle's handler ${name} (${inputName})`, async () => {
        const { port1, port2 } = newChannel();
        const channelName = "sub";
        const server = (async () => {
          for await (const _ of ioHandle<number, number>(port2, handler, { channelName })) break;
        })();
        try {
          const got: number[] = [];
          await withDeadline(
            (async () => {
              for await (const v of ioSend<number, number>(port1, makeInput(), { channelName }))
                got.push(v);
            })(),
            PROMPT_MS,
          );
          expect(got).toEqual([10, 20]);
          await withDeadline(server, PROMPT_MS);
          await new Promise((r) => setTimeout(r, 20));
          expect(unhandled).toEqual([]);
        } finally {
          port1.close();
          port2.close();
        }
      });
    }
  }

  // An older peer posts no `cancel-channel`: the caller stops sending once
  // the peer's outer call settles.
  for (const [name, handler] of [
    ["never reads its input", neverReads],
    ["reads one item then breaks", readsOneThenBreaks],
  ] as const) {
    it(`callBidi ends promptly against a 0.10 listenBidi whose handler ${name}`, async () => {
      const { port1, port2 } = newChannel();
      const close = v010.listenBidi<number, number>(port2, handler);
      try {
        const got: number[] = [];
        await withDeadline(
          (async () => {
            for await (const v of callBidi<number, number>(port1, slowInput())) got.push(v);
          })(),
          PROMPT_MS,
        );
        expect(got).toEqual([10, 20]);
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandled).toEqual([]);
      } finally {
        close();
        port1.close();
        port2.close();
      }
    });

    // statewalker/webrun-wire#164: a bare `ioSend` has no outer call to
    // settle, so it must stop sending once the peer's stream has ended.
    for (const [inputName, makeInput] of [
      ["an array", () => [1, 2, 3]],
      ["a slow generator", slowInput],
    ] as const) {
      it(`a bare ioSend ends promptly against a 0.10 ioHandle whose handler ${name} (${inputName})`, async () => {
        const { port1, port2 } = newChannel();
        const channelName = "sub";
        const server = (async () => {
          for await (const _ of v010.ioHandle<number, number>(port2, handler, { channelName }))
            break;
        })();
        try {
          const got: number[] = [];
          await withDeadline(
            (async () => {
              for await (const v of ioSend<number, number>(port1, makeInput(), { channelName }))
                got.push(v);
            })(),
            PROMPT_MS,
          );
          expect(got).toEqual([10, 20]);
          await withDeadline(server, PROMPT_MS);
          await new Promise((r) => setTimeout(r, 20));
          expect(unhandled).toEqual([]);
        } finally {
          port1.close();
          port2.close();
        }
      });
    }
  }
});

describe("ioSend still delivers all of its output to a handler that reads it", () => {
  for (const [peerName, peerIoHandle] of [
    ["the current ioHandle", ioHandle],
    ["a 0.10 ioHandle", v010.ioHandle],
  ] as const) {
    it(`against ${peerName}, every chunk reaches the handler before its stream ends`, async () => {
      const { port1, port2 } = newChannel();
      const channelName = "sub";
      const seen: number[] = [];
      const sumAll = async (input: AsyncIterable<number>) =>
        (async function* () {
          let sum = 0;
          for await (const v of input) {
            seen.push(v);
            sum += v;
          }
          yield sum;
        })();
      const server = (async () => {
        for await (const _ of peerIoHandle<number, number>(port2, sumAll, { channelName })) break;
      })();
      try {
        const got: number[] = [];
        await withDeadline(
          (async () => {
            for await (const v of ioSend<number, number>(port1, slowInput(), { channelName }))
              got.push(v);
          })(),
          PROMPT_MS,
        );
        expect(got).toEqual([6]);
        expect(seen).toEqual([1, 2, 3]);
        await withDeadline(server, PROMPT_MS);
      } finally {
        port1.close();
        port2.close();
      }
    });
  }
});
