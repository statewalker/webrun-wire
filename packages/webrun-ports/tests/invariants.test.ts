import type { MessageTarget } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { multiplexPort } from "../src/multiplex-port.js";
import { structuredCodec } from "../src/structured-codec.js";
import type { PortMux } from "../src/types.js";

/** Real MessagePorts: a MessagePort satisfies MessageTarget structurally. */
function newChannel() {
  const channel = new MessageChannel();
  rawPorts.push(channel.port1, channel.port2);
  return { a: channel.port1, b: channel.port2 };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const muxes: PortMux[] = [];
function track<T extends PortMux>(mux: T): T {
  muxes.push(mux);
  return mux;
}

// A live MessagePort keeps the Node process alive, so both raw ports of every
// channel are tracked here and closed in afterEach, even the ones no mux ever
// held (a mux closes only its own underlying port on close()).
const rawPorts: MessagePort[] = [];

afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
  for (const port of rawPorts.splice(0)) port.close();
});

describe("layer 1 invariants", () => {
  it("drops a message for an unknown id, and does not conjure a port for it", async () => {
    const { a, b } = newChannel();
    const opened: unknown[] = [];
    const accepted: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port, meta) => {
          opened.push(meta);
          port.addEventListener("message", (event) => accepted.push(event.data));
        },
      }),
    );

    // Forge traffic for an id that was never opened.
    a.postMessage({ type: "message", id: 40, payload: "ghost" });
    a.start();
    await tick();

    // Then open a real port and send on it.
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    const port = client.openPort("real-port");
    port.postMessage("real");
    await tick();
    await tick();

    // Ceiling: the forged id produced no port at all. An implementation that
    // queued the message, or attached a port on first sight of an id, would
    // announce it here.
    expect(opened).toEqual(["real-port"]);
    // Floor: a genuine message still arrives, so the absence above is evidence
    // rather than an artefact of nothing having run.
    expect(accepted).toEqual(["real"]);
  });

  it("drops messages for a port the peer already closed", async () => {
    const { a, b } = newChannel();
    const seen: unknown[] = [];
    let serverPort: { close?: () => void } | undefined;
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          serverPort = port;
          port.addEventListener("message", (event) => seen.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    port.postMessage("before");
    await tick();
    serverPort?.close?.();
    await tick();
    port.postMessage("after");
    await tick();

    expect(seen).toEqual(["before"]);
  });

  it("keeps ports isolated: one closing does not disturb another", async () => {
    const { a, b } = newChannel();
    const perPort = new Map<unknown, unknown[]>();
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port, meta) => {
          const log: unknown[] = [];
          perPort.set(meta, log);
          port.addEventListener("message", (event) => log.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const first = client.openPort("first");
    const second = client.openPort("second");
    await tick();

    first.postMessage(1);
    second.postMessage(2);
    await tick();

    first.close?.();
    await tick();

    second.postMessage(3);
    await tick();

    expect(perPort.get("first")).toEqual([1]);
    expect(perPort.get("second")).toEqual([2, 3]);
  });

  it("preserves ordering within a port", async () => {
    const { a, b } = newChannel();
    const seen: number[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => seen.push(event.data as number));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    for (let i = 0; i < 50; i++) port.postMessage(i);
    await tick();
    await tick();

    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("closes both ends when either closes, and is idempotent", async () => {
    const { a, b } = newChannel();
    let serverPort: MessageTarget | undefined;
    // Watch the responder's own outbound wire: it is the only place that
    // distinguishes "the far end went inert" from "the near end stopped
    // listening", and the two look identical from the client's side.
    let serverMessages = 0;
    let clientCloses = 0;
    b.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "close") clientCloses++;
    });
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          serverPort = port;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") serverMessages++;
    });

    const port = client.openPort();
    await tick();

    // Floor: before the close, the responder's end genuinely works.
    serverPort?.postMessage("before-close");
    await tick();
    expect(serverMessages).toBe(1);

    port.close?.();
    port.close?.();
    await tick();

    // Ceiling: the close reached the responder and made its end inert, so this
    // post never becomes an envelope.
    serverPort?.postMessage("after-close");
    await tick();
    expect(serverMessages).toBe(1);

    // Idempotent: two local closes put exactly one close on the wire.
    expect(clientCloses).toBe(1);
  });

  it("refuses to open beyond maxPorts, and rejects an inbound OPEN beyond it", async () => {
    const { a, b } = newChannel();
    const acceptedIds: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        maxPorts: 2,
        onPort: (_port, meta) => {
          acceptedIds.push(meta);
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, maxPorts: 2 }));

    client.openPort("one");
    client.openPort("two");
    expect(() => client.openPort("three")).toThrow(RangeError);
    await tick();

    expect(acceptedIds).toEqual(["one", "two"]);
  });

  it("composes: a multiplexer over a virtual port yields more ports", async () => {
    const { a, b } = newChannel();

    // Outer layer.
    let innerServerSide: MessageTarget | undefined;
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          innerServerSide = port;
        },
      }),
    );
    const outerClient = track(multiplexPort(a, { codec: structuredCodec }));
    const carrier = outerClient.openPort();
    await tick();

    // Inner layer, riding on one virtual port of the outer one.
    const seen: unknown[] = [];
    if (!innerServerSide) throw new Error("outer port was never accepted");
    track(
      multiplexPort(innerServerSide, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => seen.push(event.data));
        },
      }),
    );
    const innerClient = track(multiplexPort(carrier, { codec: structuredCodec }));
    const innerPort = innerClient.openPort();
    innerPort.postMessage("through two layers");
    await tick();
    await tick();

    expect(seen).toEqual(["through two layers"]);
  });
});
