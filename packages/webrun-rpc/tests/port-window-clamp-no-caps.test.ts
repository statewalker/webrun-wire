import { deserialize, serialize } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageTarget, PortCodec, PortEnvelope } from "../src/index.js";
import { multiplexPort, structuredCodec } from "../src/index.js";
import { portAgreement } from "../src/port-credit.js";

// statewalker/webrun-wire#202: an opener whose `open` does not list the
// `"window"` capability (an older peer, or a hostile one) was granted
// whatever window it asked for. The responder now clamps it to its own, as
// it does for an opener that lists the capability (#145).

const KiB = 1024;
const SMALL = 16 * KiB;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A byte codec that counts exact sizes: Node's structured serializer. */
const v8Codec: PortCodec = {
  post: (port, envelope) => port.postMessage(v8Codec.encode?.(envelope)),
  read: (event) => v8Codec.decode?.(event.data),
  encode: (envelope) => new Uint8Array(serialize(envelope)),
  decode: (data) => {
    if (!(data instanceof Uint8Array)) return undefined;
    const value = deserialize(data) as PortEnvelope;
    return typeof value?.id === "number" && typeof value.type === "string" ? value : undefined;
  },
  halfClose: true,
};

/** A responder with a small window whose ports' listeners never finish a message. */
function responder(codec: PortCodec, maxReassembledBytes?: number) {
  const ch = new MessageChannel();
  cleanups.push(() => {
    ch.port1.close();
    ch.port2.close();
  });
  const served: MessageTarget[] = [];
  const server = multiplexPort(ch.port2, {
    codec,
    side: "responder",
    window: SMALL,
    ...(maxReassembledBytes !== undefined ? { maxReassembledBytes } : {}),
    onPort: (port) => {
      served.push(port);
      port.addEventListener("message", () => new Promise<void>(() => {}));
      return true;
    },
  });
  cleanups.push(() => server.close());
  const received: PortEnvelope[] = [];
  ch.port1.onmessage = (event) => {
    const envelope = codec === v8Codec ? v8Codec.decode?.(event.data) : event.data;
    if (envelope) received.push(envelope as PortEnvelope);
  };
  const send = (envelope: PortEnvelope) =>
    ch.port1.postMessage(codec === v8Codec ? v8Codec.encode?.(envelope) : envelope);
  return { server, served, received, send };
}

describe("an opener without the window capability (statewalker/webrun-wire#202)", () => {
  it("asking for a window far above the responder's own is granted at most the responder's", async () => {
    const { served, received, send } = responder(structuredCodec);
    send({ type: "open", id: 0, window: Number.MAX_SAFE_INTEGER } satisfies PortEnvelope);
    await waitFor(() => received.length > 0, "the ack");
    // No capabilities listed: the ack carries none (an older peer would not read them).
    expect(received[0]).toMatchObject({ type: "credit", id: 0, bytes: 0 });
    expect(received[0]).not.toHaveProperty("window");
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(SMALL);
  });

  it("memory held for such a port stays at most about one own window", async () => {
    const { served, received, send } = responder(v8Codec);
    send({
      type: "open",
      id: 0,
      window: Number.MAX_SAFE_INTEGER,
      exact: true,
    } satisfies PortEnvelope);
    await waitFor(() => received.length > 0, "the ack");
    // One message the listener never finishes: something is owed from here on.
    send({ type: "message", id: 0, payload: new Uint8Array(1024) });
    await waitFor(() => served.length > 0, "the port");
    // Then a framed message far past the window, as the window it asked for allows.
    const frame = new Uint8Array(4 * KiB);
    for (let i = 0; i < 64; i++) send({ type: "frame", id: 0, data: frame });
    await waitFor(
      () => received.some((e) => e.type === "close" && e.id === 0),
      "the responder closes the port",
    );
    const close = received.find((e) => e.type === "close") as Extract<
      PortEnvelope,
      { type: "close" }
    >;
    expect(String(close.reason)).toMatch(/max-reassembled-bytes/);
  });
});

// Review of #205: an opener from before `"window"` keeps counting against the
// window it asked for. Asking for no more than the responder's, it runs as
// before; asking for more and really filling more before its credit returns
// (pipelined chunks to a slow consumer), it has its port failed: the
// documented cost of the clamp (#202). Follow-up: statewalker/webrun-wire#207.
describe("an honest 0.10 opener against a new responder that clamps (review of #205)", () => {
  async function uploadFrom010(openerWindow: number): Promise<string> {
    const v010 = (await import("webrun-rpc-0-10")) as unknown as typeof import("../src/index.js");
    const { serveDuplexOverPort } = await import("../src/index.js");
    const ch = new MessageChannel();
    cleanups.push(() => {
      ch.port1.close();
      ch.port2.close();
    });
    const server = multiplexPort(ch.port2, {
      codec: v8Codec,
      side: "responder",
      window: SMALL,
      onPort: (port) => {
        serveDuplexOverPort(port, async function* (input) {
          let n = 0;
          for await (const chunk of input) {
            n += chunk.byteLength;
            await new Promise((r) => setTimeout(r, 1));
          }
          yield new TextEncoder().encode(String(n));
        });
        return true;
      },
    });
    const client = v010.multiplexPort(ch.port1, {
      codec: v8Codec,
      side: "initiator",
      window: openerWindow,
      frameSize: 4096,
    });
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    async function* upload() {
      for (let i = 0; i < 100; i++) yield new Uint8Array(12000).fill(i & 0xff);
    }
    const port = await client.openPort();
    let answer = "";
    for await (const chunk of v010.duplexOverPort(port)(upload())) {
      answer += new TextDecoder().decode(chunk);
    }
    return answer;
  }

  it("asking for no more than the responder's window: a pipelined upload to a slow consumer completes", async () => {
    expect(await uploadFrom010(SMALL)).toBe("1200000");
  }, 20_000);

  it("asking for more, and filling more before its credit returns: its port is failed, not held", async () => {
    await expect(uploadFrom010(1024 * KiB)).rejects.toThrow(/closed the port/);
  }, 20_000);
});
