import { afterEach, describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/message-target.js";
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
 * light load and sometimes loses under a heavier one (this suite plus three
 * other files running concurrently measured an 8% failure rate on unmutated
 * code). Polling on the actual condition removes the race instead of
 * relocating it.
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
          port.addEventListener("message", (event) => {
            accepted.push(event.data);
          });
        },
      }),
    );

    // Forge traffic for an id that was never opened.
    a.postMessage({ type: "message", id: 40, payload: "ghost" });
    a.start();

    // Then open a real port and send on it. Per-channel ordering guarantees
    // the ghost above is processed strictly before this envelope, so waiting
    // for the real message to land is a valid sentinel for "the ghost has
    // already been handled, one way or another" — the absence check below is
    // evidence, not an artefact of checking too early.
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    const port = await client.openPort("real-port");
    port.postMessage("real");
    await waitFor(() => accepted.length > 0, "the real message is delivered");

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
          port.addEventListener("message", (event) => {
            seen.push(event.data);
          });
        },
      }),
    );
    // Sentinel: counts "message" envelopes arriving at `b`. A single dispatch
    // runs every listener on the target to completion before any later
    // `await` can observe this counter, so once it reaches 2 the mux has
    // already finished handling "after" — delivered or dropped.
    let messageEnvelopesSeenAtB = 0;
    b.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") messageEnvelopesSeenAtB++;
    });
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = await client.openPort();
    port.postMessage("before");
    await waitFor(() => seen.length > 0, "the peer received 'before'");

    serverPort?.close?.();
    port.postMessage("after");
    await waitFor(() => messageEnvelopesSeenAtB > 1, "the second envelope reaches the peer");

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
          port.addEventListener("message", (event) => {
            log.push(event.data);
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const first = await client.openPort("first");
    const second = await client.openPort("second");
    await waitFor(() => perPort.has("first") && perPort.has("second"), "both ports accepted");

    first.postMessage(1);
    second.postMessage(2);
    await waitFor(
      () => (perPort.get("first")?.length ?? 0) > 0 && (perPort.get("second")?.length ?? 0) > 0,
      "both messages delivered",
    );

    first.close?.();
    second.postMessage(3);
    // Per-channel ordering: the close for "first" is sent before this post,
    // so by the time "second" has its post-close message, "first" closing
    // has already been fully processed too.
    await waitFor(
      () => (perPort.get("second")?.length ?? 0) > 1,
      "second port received the post-close message",
    );

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
          port.addEventListener("message", (event) => {
            seen.push(event.data as number);
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = await client.openPort();
    for (let i = 0; i < 50; i++) port.postMessage(i);
    await waitFor(() => seen.length >= 50, "all 50 messages arrive");

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

    const port = await client.openPort();
    await waitFor(() => serverPort !== undefined, "responder accepted the port");

    // Floor: before the close, the responder's end genuinely works.
    serverPort?.postMessage("before-close");
    await waitFor(() => serverMessages > 0, "before-close reaches the opener");
    expect(serverMessages).toBe(1);

    port.close?.();
    port.close?.();
    await waitFor(() => clientCloses > 0, "the close reaches the responder");

    // Ceiling: the close reached the responder and made its end inert — the
    // wait above already confirms the responder's mux processed it, so this
    // post is a synchronous local no-op, nothing left to poll for.
    serverPort?.postMessage("after-close");
    expect(serverMessages).toBe(1);

    // Idempotent: two local closes put exactly one close on the wire. No
    // second close can still be in flight — the guard inside the virtual
    // port's own close() is synchronous, so at most one was ever sent.
    expect(clientCloses).toBe(1);
  });

  // The inbound half — a forged OPEN past the ceiling — is covered
  // separately in lifecycle.test.ts's "rejects an inbound OPEN once the
  // responder's own maxPorts is reached": a conforming client throws locally
  // before ever emitting a third OPEN, so this test cannot reach that path.
  it("refuses to open beyond maxPorts locally", async () => {
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

    // Deliberately not awaited: only the synchronous prefix of openPort (the
    // part that puts OPEN on the wire) needs to run before the accept-count
    // check below; both promises resolve on their own.
    client.openPort("one");
    client.openPort("two");
    // openPort is async: a guard failure (maxPorts reached) rejects the
    // returned promise instead of throwing synchronously.
    await expect(client.openPort("three")).rejects.toThrow(RangeError);
    await waitFor(() => acceptedIds.length >= 2, "both ports accepted");

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
    const carrier = await outerClient.openPort();
    await waitFor(() => innerServerSide !== undefined, "the outer port is accepted");

    // Inner layer, riding on one virtual port of the outer one.
    const seen: unknown[] = [];
    if (!innerServerSide) throw new Error("outer port was never accepted");
    track(
      multiplexPort(innerServerSide, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => {
            seen.push(event.data);
          });
        },
      }),
    );
    const innerClient = track(multiplexPort(carrier, { codec: structuredCodec }));
    const innerPort = await innerClient.openPort();
    innerPort.postMessage("through two layers");
    await waitFor(() => seen.length > 0, "the message crosses both mux layers");

    expect(seen).toEqual(["through two layers"]);
  });
});
