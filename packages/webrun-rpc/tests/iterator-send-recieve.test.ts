import { recieveIterator, sendIterator } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { callPort } from "../src/call-port.js";
import { listenPort } from "../src/listen-port.js";
import { recieve } from "../src/recieve.js";
import { send } from "../src/send.js";

async function* makeAsync<T>(items: Iterable<T>, maxTimeout = 20): AsyncGenerator<T> {
  for (const value of items) {
    await new Promise((r) => setTimeout(r, Math.random() * maxTimeout));
    yield value;
  }
}

function newChannel() {
  const c = new MessageChannel();
  c.port1.start();
  c.port2.start();
  return c;
}

describe("sendIterator (transport-agnostic)", () => {
  async function run<T>(input: AsyncIterable<T> | Iterable<T>, control: T[]) {
    const received: T[] = [];
    let doneCalls = 0;
    await sendIterator<T>(async ({ done, value }) => {
      if (done) doneCalls += 1;
      else received.push(value as T);
    }, input);
    expect(received).toEqual(control);
    expect(doneCalls).toBe(1);
  }

  it("drains a sync iterable", () => run([1, 2, 3], [1, 2, 3]));
  it("drains an async iterable", () => run(makeAsync([1, 2, 3]), [1, 2, 3]));
  it("sends the trailing error in the done chunk", async () => {
    let captured: unknown;
    const bomb = (async function* () {
      yield 1;
      throw new Error("boom");
    })();
    await sendIterator<number>(async ({ done, error }) => {
      if (done) captured = error;
    }, bomb);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("boom");
  });
});

describe("recieveIterator (transport-agnostic)", () => {
  it("reassembles an iterator from chunk callbacks", async () => {
    const it = recieveIterator<number>((deliver) => {
      (async () => {
        for (const v of [1, 2, 3]) await deliver({ done: false, value: v });
        await deliver({ done: true });
      })();
    });
    const seen: number[] = [];
    for await (const v of it) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("rethrows the error forwarded in the done chunk", async () => {
    const err = new Error("propagated");
    const it = recieveIterator<number>((deliver) => {
      (async () => {
        await deliver({ done: false, value: 1 });
        await deliver({ done: true, error: err });
      })();
    });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of it) seen.push(v);
      })(),
    ).rejects.toBe(err);
    expect(seen).toEqual([1]);
  });
});

describe("send + recieve over a MessageChannel", () => {
  async function run<T>(
    dataToSend: AsyncIterable<T> | Iterable<T>,
    control: T[],
    channelName = "",
  ) {
    const { port1, port2 } = newChannel();
    void send<T>(port2, dataToSend, { channelName });

    const values: T[] = [];
    for await (const input of recieve<T>(port1, { channelName })) {
      for await (const value of input) {
        await new Promise((r) => setTimeout(r, 5));
        values.push(value);
      }
      break;
    }
    expect(values).toEqual(control);
  }

  it("transports sync values on the default channel", () => run([1, 2, 3], [1, 2, 3]));
  it("transports async values on a named channel", () =>
    run(makeAsync(["a", "b", "c"]), ["a", "b", "c"], "names"));
  it("keeps channels isolated", async () => {
    const { port1, port2 } = newChannel();

    // Install both receivers first so no messages are missed.
    const xsPromise = (async () => {
      const xs: number[] = [];
      for await (const input of recieve<number>(port1, { channelName: "x" })) {
        for await (const v of input) xs.push(v);
        break;
      }
      return xs;
    })();
    const ysPromise = (async () => {
      const ys: string[] = [];
      for await (const input of recieve<string>(port1, { channelName: "y" })) {
        for await (const v of input) ys.push(v);
        break;
      }
      return ys;
    })();

    // Yield so the receivers register their listeners.
    await new Promise((r) => setTimeout(r, 0));

    await Promise.all([
      send(port2, [1, 2, 3], { channelName: "x" }),
      send(port2, ["a", "b"], { channelName: "y" }),
    ]);

    expect(await xsPromise).toEqual([1, 2, 3]);
    expect(await ysPromise).toEqual(["a", "b"]);
  });
});

describe("sendIterator wired to callPort/listenPort", () => {
  it("invokes the handler once per chunk plus one done-call", async () => {
    const { port1, port2 } = newChannel();
    const values: number[] = [];
    let calls = 0;
    const close = listenPort<{ done: boolean; value?: number }>(port1, async ({ done, value }) => {
      if (!done && value !== undefined) values.push(value);
      calls++;
    });
    try {
      await sendIterator<number>(
        async (chunk) => {
          await callPort(port2, chunk);
        },
        [10, 20, 30],
      );
      expect(values).toEqual([10, 20, 30]);
      expect(calls).toBe(4); // 3 values + done
    } finally {
      close();
    }
  });
});
