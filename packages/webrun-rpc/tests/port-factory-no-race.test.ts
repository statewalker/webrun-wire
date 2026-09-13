/**
 * Why `PortParams.mux` is a FACTORY and not a `PortMux`.
 *
 * Every mux decides accept-or-reject **synchronously**, inside the `open`
 * envelope, and tells the peer on the spot — `multiplexPort` posts
 * `{type:"close", reason:"rejected"}` before returning. There is no "decide
 * later", and layer 1 refuses to queue what it cannot deliver.
 *
 * So the alternative design — hand `serve` a mux that already exists and let it
 * subscribe — has a window between construction and subscription in which
 * inbound ports are rejected outright. The first test below measures that
 * window on a mux with no handler, which is exactly what a not-yet-subscribed
 * mux is. The second shows the factory has no such window, because the mux
 * cannot exist before the thing that answers it.
 *
 * This is the whole argument for the shape of the API, so it is a test rather
 * than a paragraph in a README.
 */

import { describe, expect, it } from "vitest";
import { connect, multiplexPort, overPipe, serve, structuredCodec } from "../src/index.js";

const empty = async function* (): AsyncGenerator<Uint8Array> {};

function pair() {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return channel;
}

describe("the window a subscribable onPort would leave open", () => {
  it("rejects a port that arrives before any handler is attached", async () => {
    // A mux built without `onPort` IS a mux whose subscriber has not arrived
    // yet. Nothing reaches a consumer, and the peer is told `rejected` — for a
    // call whose only fault was being early.
    const channel = pair();
    const responder = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
    });
    const initiator = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
    });

    const port = await initiator.openPort({ kind: "stream" });
    let delivered = 0;
    port.addEventListener("message", () => {
      delivered++;
    });
    port.start?.();
    port.postMessage({ hello: true });

    await new Promise((r) => setTimeout(r, 150));
    expect(delivered).toBe(0);

    await initiator.close();
    await responder.close();
    channel.port1.close();
    channel.port2.close();
  });
});

describe("the factory closes it", () => {
  it("answers a call made the instant serve() resolves", async () => {
    // No `await` between the mux existing and the handler being installed:
    // the factory receives `onPort` and passes it into the constructor, so the
    // first envelope the mux can possibly see already has somewhere to go.
    const channel = pair();

    const teardown = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      async function* () {
        yield new Uint8Array([42]);
      },
    );
    const { call, close } = await connect({
      mux: overPipe(channel.port1, { codec: structuredCodec, side: "initiator" }),
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of call(empty())) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([42])]);

    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });

  it("the same consumer runs over a mux this package knows nothing about", async () => {
    // `overPorts` is a pass-through, and that is the point: an adapter builds
    // its own `PortMux` — over libp2p, over a transferable boundary — and
    // `connect`/`serve` neither know nor care. Here a hand-rolled factory
    // stands in for one, using `multiplexPort` underneath only because this
    // package has no other transport to hand.
    const channel = pair();
    let built = 0;

    const teardown = await serve(
      {
        mux: (onPort) => {
          built++;
          return multiplexPort(channel.port2, {
            codec: structuredCodec,
            side: "responder",
            onPort,
          });
        },
      },
      async function* () {
        yield new Uint8Array([7]);
      },
    );
    const { call, close } = await connect({
      mux: (onPort) => {
        built++;
        // A caller is handed `undefined`, which is how it declines inbound
        // ports — the same refusal, expressed by the same seam.
        expect(onPort).toBeUndefined();
        return multiplexPort(channel.port1, { codec: structuredCodec, side: "initiator" });
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of call(empty())) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([7])]);
    expect(built).toBe(2);

    await close();
    await teardown();
    channel.port1.close();
    channel.port2.close();
  });
});
