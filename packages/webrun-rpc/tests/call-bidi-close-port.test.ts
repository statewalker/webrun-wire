import { afterEach, describe, expect, it } from "vitest";
import { callBidi } from "../src/call-bidi.js";
import { listenBidi } from "../src/listen-bidi.js";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];

afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
  for (const port of rawPorts.splice(0)) port.close();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A client mux and a server mux that serves `listenBidi` on every port it accepts. */
function muxPair() {
  const channel = new MessageChannel();
  rawPorts.push(channel.port1, channel.port2);
  const server = multiplexPort(channel.port2, {
    codec: structuredCodec,
    side: "responder",
    onPort: (port) => {
      listenBidi<undefined, number>(port, async function* () {
        for (let i = 0; ; i++) yield i;
      });
    },
  });
  const client = multiplexPort(channel.port1, { codec: structuredCodec });
  muxes.push(server, client);
  return { client, server };
}

describe("callBidi's closePort option (statewalker/webrun-wire#217)", () => {
  it("closes the mux port once the consumer breaks", async () => {
    const { client, server } = muxPair();
    const control = await client.openPort("control");
    for (let n = 0; n < 3; n++) {
      const port = await client.openPort("subscription");
      expect(client.ports().length).toBe(2);
      const seen: number[] = [];
      for await (const v of callBidi<undefined, number>(port, [], {
        options: { closePort: true },
      })) {
        seen.push(v);
        if (seen.length === 2) break;
      }
      expect(seen).toEqual([0, 1]);
      expect(client.ports().length).toBe(1);
      await waitFor(
        () => server.ports().length === 1,
        "the server dropped the subscription's port",
      );
    }
    control.close?.();
  });

  it("closes the mux port once the stream ends or the handler throws", async () => {
    const channel = new MessageChannel();
    rawPorts.push(channel.port1, channel.port2);
    const server = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (port, meta) => {
        listenBidi<undefined, number>(port, async function* () {
          yield 1;
          if (meta === "fail") throw new Error("handler failed");
        });
      },
    });
    const client = multiplexPort(channel.port1, { codec: structuredCodec });
    muxes.push(server, client);

    const ok = await client.openPort("ok");
    const out: number[] = [];
    for await (const v of callBidi<undefined, number>(ok, [], { options: { closePort: true } }))
      out.push(v);
    expect(out).toEqual([1]);
    expect(client.ports().length).toBe(0);

    const failing = await client.openPort("fail");
    await expect(
      (async () => {
        for await (const _ of callBidi<undefined, number>(failing, [], {
          options: { closePort: true },
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("handler failed");
    expect(client.ports().length).toBe(0);
  });

  it("leaves the port open by default: the caller owns it", async () => {
    const { client } = muxPair();
    const port = await client.openPort("subscription");
    for await (const v of callBidi<undefined, number>(port, [])) {
      if (v === 1) break;
    }
    expect(client.ports().length).toBe(1);
    // The port still carries calls.
    for await (const v of callBidi<undefined, number>(port, [])) {
      expect(v).toBe(0);
      break;
    }
    port.close?.();
    expect(client.ports().length).toBe(0);
  });
});
