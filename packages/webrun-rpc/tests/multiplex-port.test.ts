import { afterEach, describe, expect, it } from "vitest";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

/** Real MessagePorts: a MessagePort satisfies MessageTarget structurally. */
function newChannel() {
  const channel = new MessageChannel();
  rawPorts.push(channel.port1, channel.port2);
  return { a: channel.port1, b: channel.port2 };
}

/**
 * Poll `predicate` until it is true, or fail with `label`. A fixed number of
 * macrotask ticks is a race, not a synchronisation: it usually wins under a
 * light load and sometimes loses under a heavier one (this file plus three
 * others running concurrently measured an 8% failure rate on unmutated code).
 * Polling on the actual condition removes the race instead of relocating it.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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
          port.addEventListener("message", (event) => {
            received.push(event.data);
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, side: "initiator" }));

    const port = await client.openPort();
    port.postMessage("ping");
    await waitFor(() => received.length > 0, "message received");

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
    await waitFor(() => seen !== "not called", "onPort invoked with meta");

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

    const port = await client.openPort();
    const atClient: unknown[] = [];
    port.addEventListener("message", (event) => {
      atClient.push(event.data);
    });
    port.postMessage("one");
    await waitFor(() => atServer.length > 0, "server received the message");
    await waitFor(() => atClient.length > 0, "client received the echo");

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
    await waitFor(() => ids.length >= 2, "both opens observed on the wire");
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
    await waitFor(() => otherIds.length >= 2, "both opens observed on the wire");
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
          port.addEventListener("message", (event) => {
            delivered.push(event.data);
          });
          return false;
        },
      }),
    );
    // Sentinel for the ceiling below: this fires only once the "message"
    // envelope has been dispatched on `b`, and a single dispatch runs every
    // listener on the target to completion — including the mux's own,
    // wherever it sits in registration order — before any later `await` can
    // observe the counter. By the time this is > 0, the mux has already
    // dropped (or delivered) that exact envelope.
    let rejectedMessageSeenAtB = 0;
    b.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") rejectedMessageSeenAtB++;
    });
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    // Same technique, for the floor: fires only once the close envelope sent
    // back by the rejection has been dispatched on `a`, by which point the
    // opener's mux has already marked its own end inert.
    let closeSeenAtA = 0;
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "close") closeSeenAtA++;
    });

    const port = await client.openPort();
    port.postMessage("before-rejection");
    await waitFor(() => rejectedMessageSeenAtB > 0, "the rejected message reaches the responder");

    // Ceiling: nothing reached the rejected port's listener.
    expect(delivered).toEqual([]);

    await waitFor(() => closeSeenAtA > 0, "the rejection's close reaches the opener");

    // Floor: the rejection reached the opener and made its end inert. The
    // opener's mux already saw the close (waited for above), so this post is
    // a synchronous local no-op — nothing to poll for, only to confirm.
    let messagesOnWire = 0;
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") messagesOnWire++;
    });
    port.postMessage("after-rejection");
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
    await waitFor(() => closes.length > 0, "close arrives for the rejected port");

    expect(closes).toEqual([0]);
  });
});
