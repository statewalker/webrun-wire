import { msgpackCodec } from "@statewalker/webrun-msgpack";
import {
  callBidi,
  listenBidi,
  methodsClient,
  multiplexPort,
  overPipe,
  serveMethods,
} from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { type ExtensionConnection, extensionConnection } from "./extension-stack.js";

const open: ExtensionConnection[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

interface Methods {
  add(a: number, b: number): number;
  echo(value: unknown): unknown;
  sleep(ms: number): Promise<string>;
}
const METHODS = ["add", "echo", "sleep"] as const;

/** A broker in the worker: methods on a `methods` port, an event stream on an `events` port. */
function broker(connection: ExtensionConnection) {
  const stats = { eventsOpen: 0, finallyCount: 0 };
  const impl: Methods = {
    add: (a, b) => a + b,
    echo: (value) => value,
    sleep: (ms) => new Promise((r) => setTimeout(() => r(`slept ${ms}`), ms)),
  };
  overPipe(connection.worker.target, { codec: msgpackCodec, side: "responder" })((port, meta) => {
    const kind = (meta as { kind?: string } | undefined)?.kind;
    if (kind === "methods")
      serveMethods(port, impl, { channelName: "methods", methods: [...METHODS] });
    if (kind === "events") {
      listenBidi<undefined, { tick: number }>(port, async function* () {
        stats.eventsOpen++;
        try {
          for (let tick = 0; ; tick++) {
            await new Promise((r) => setTimeout(r, 5));
            yield { tick };
          }
        } finally {
          stats.eventsOpen--;
          stats.finallyCount++;
        }
      });
    }
  });
  return stats;
}

function setUp() {
  const connection = extensionConnection();
  open.push(connection);
  const stats = broker(connection);
  const mux = multiplexPort(connection.page.target, {
    codec: msgpackCodec,
    side: "initiator",
    signal: connection.page.signal,
  });
  return { connection, stats, mux };
}

describe("an extension connection: page -> content script -> service worker", () => {
  it("carries request/response calls", async () => {
    const { mux } = setUp();
    const client = methodsClient<Methods>(await mux.openPort({ kind: "methods" }), {
      channelName: "methods",
      methods: [...METHODS],
    });
    expect(await client.add(2, 3)).toBe(5);
    const nested = { text: "héllo ✓", list: [1, { deep: true }], bytes: new Uint8Array([1, 2]) };
    expect(await client.echo(nested)).toEqual(nested);
    const parallel = await Promise.all(Array.from({ length: 50 }, (_, i) => client.add(i, i)));
    expect(parallel).toEqual(Array.from({ length: 50 }, (_, i) => 2 * i));
  });

  it("an event stream cancelled by break runs the worker's finally and leaves no port", async () => {
    const { mux, stats } = setUp();
    const ticks: number[] = [];
    const port = await mux.openPort({ kind: "events" });
    for await (const event of callBidi<undefined, { tick: number }>(port, [], {
      options: { closePort: true },
    })) {
      ticks.push(event.tick);
      if (ticks.length === 5) break;
    }
    expect(ticks).toEqual([0, 1, 2, 3, 4]);
    await expect.poll(() => stats.finallyCount).toBe(1);
    expect(stats.eventsOpen).toBe(0);
    expect(mux.ports()).toEqual([]);
  });

  it("a service worker stopping fails every pending call with the chained reason", async () => {
    const { connection, mux, stats } = setUp();
    const client = methodsClient<Methods>(await mux.openPort({ kind: "methods" }), {
      channelName: "methods",
      methods: [...METHODS],
    });
    const events = callBidi<undefined, { tick: number }>(
      await mux.openPort({ kind: "events" }),
      [],
    )[Symbol.asyncIterator]();
    await events.next();
    const pending = client.sleep(10_000);
    const stream = events.next();

    // Chrome tears the port down when the worker stops: the content script's end disconnects.
    connection.contentPort.dropFromPeer();

    await expect(pending).rejects.toThrow(/cs<->sw: the chrome.runtime.Port disconnected/);
    await expect(stream).rejects.toThrow();
    await expect.poll(() => connection.page.signal.aborted).toBe(true);
    expect((connection.page.signal.reason as Error).message).toBe(
      "page<->cs: the peer closed: cs<->sw: the chrome.runtime.Port disconnected",
    );
    // A later call on the dead connection fails at once.
    await expect(mux.openPort({ kind: "methods" })).rejects.toThrow();
    void stats;
  });

  it("the page going away disconnects the chrome port: the worker's pipe ends", async () => {
    const { connection } = setUp();
    await connection.page.target.close();
    await expect.poll(() => connection.worker.signal.aborted).toBe(true);
    expect(connection.contentPort.connected).toBe(false);
  });
});
