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

/** MessagePort delivery is a macrotask; give it one. */
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

describe("multiplexPort", () => {
  it("delivers a message from an opened port to the accepting peer", async () => {
    const { a, b } = newChannel();
    const received: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => received.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, side: "initiator" }));

    const port = client.openPort();
    port.postMessage("ping");
    await tick();

    expect(received).toEqual(["ping"]);
  });

  it("hands the opener's meta to onPort", async () => {
    const { a, b } = newChannel();
    let seen: unknown = "not called";
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (_port, meta) => {
          seen = meta;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    client.openPort({ kind: "stream" });
    await tick();

    expect(seen).toEqual({ kind: "stream" });
  });

  it("carries traffic in both directions on one virtual port", async () => {
    const { a, b } = newChannel();
    const atServer: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => {
            atServer.push(event.data);
            port.postMessage(`echo:${String(event.data)}`);
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    const atClient: unknown[] = [];
    port.addEventListener("message", (event) => atClient.push(event.data));
    port.postMessage("one");
    await tick();
    await tick();

    expect(atServer).toEqual(["one"]);
    expect(atClient).toEqual(["echo:one"]);
  });

  it("allocates even ids for the initiator and odd for the responder", async () => {
    const { a, b } = newChannel();
    const ids: number[] = [];
    // Watch the raw wire rather than the API, so the parity rule is pinned
    // where a peer implementation would actually observe it.
    b.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "open") ids.push(envelope.id);
    });
    b.start();
    const client = track(multiplexPort(a, { codec: structuredCodec, side: "initiator" }));
    client.openPort();
    client.openPort();
    await tick();
    expect(ids).toEqual([0, 2]);

    const { a: c, b: d } = newChannel();
    const otherIds: number[] = [];
    d.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "open") otherIds.push(envelope.id);
    });
    d.start();
    const server = track(multiplexPort(c, { codec: structuredCodec, side: "responder" }));
    server.openPort();
    server.openPort();
    await tick();
    expect(otherIds).toEqual([1, 3]);
  });

  it("rejects an inbound port when onPort returns false, and closes the opener's end", async () => {
    const { a, b } = newChannel();
    const delivered: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => delivered.push(event.data));
          return false;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    port.postMessage("before-rejection");
    await tick();
    await tick();

    // Ceiling: nothing reached the rejected port's listener.
    expect(delivered).toEqual([]);

    // Floor: the rejection reached the opener and made its end inert. Watching
    // the raw wire is what distinguishes "the peer closed us" from "nothing
    // ever ran" — the second post produces no envelope at all.
    let messagesOnWire = 0;
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") messagesOnWire++;
    });
    port.postMessage("after-rejection");
    await tick();
    expect(messagesOnWire).toBe(0);
  });

  it("rejects inbound ports when there is no onPort at all", async () => {
    const { a, b } = newChannel();
    // A responder that never accepts: a port nobody holds has no consumer.
    const closes: number[] = [];
    a.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "close") closes.push(envelope.id);
    });
    track(multiplexPort(b, { codec: structuredCodec, side: "responder" }));
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    client.openPort();
    await tick();
    await tick();

    expect(closes).toEqual([0]);
  });
});
