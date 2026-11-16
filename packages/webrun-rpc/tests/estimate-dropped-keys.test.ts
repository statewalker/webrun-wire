import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/index.js";
import {
  duplexOverPort,
  multiplexPort,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";
import { estimateMessageSize, withoutUndefinedKeys } from "../src/multiplex-port.js";

// statewalker/webrun-wire#203: under `structuredCodec` both ends of a windowed
// port size a message with `estimateMessageSize`, which counted every key,
// including keys whose value is `undefined`. A transport that drops such keys
// (webrun-msgpack decodes `{ a: 1, b: undefined }` as `{ a: 1 }`) made the
// receiver credit back less than the sender counted, and a message close to
// the window size then waited for ever: a silent, permanent stall.

const KiB = 1024;
const WINDOW = 64 * KiB;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A deep copy without the keys whose value is `undefined`, as a msgpack round trip makes it. */
function dropUndefined(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || depth > 16) {
    return value;
  }
  if (value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map((v) => dropUndefined(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    if (v !== undefined) out[k] = dropUndefined(v, depth + 1);
  return out;
}

/** Both ends of a channel whose transport drops `undefined`-valued keys. */
function droppingLink() {
  const ch = new MessageChannel();
  cleanups.push(() => {
    ch.port1.close();
    ch.port2.close();
  });
  const wrap = (port: MessagePort): MessageTarget => ({
    postMessage: (message: unknown) => port.postMessage(dropUndefined(message)),
    addEventListener: (type, listener) => port.addEventListener(type, listener as never),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener as never),
    start: () => port.start(),
  });
  return { a: wrap(ch.port1), b: wrap(ch.port2) };
}

const countBytes: Duplex = async function* (input) {
  let n = 0;
  for await (const chunk of input) n += chunk.byteLength;
  yield new TextEncoder().encode(String(n));
};

describe("a windowed port over a transport that drops undefined-valued keys (statewalker/webrun-wire#203)", () => {
  it("carries messages up to the window and finishes", async () => {
    const link = droppingLink();
    const server = multiplexPort(link.b, {
      codec: structuredCodec,
      side: "responder",
      window: WINDOW,
      onPort: (port) => {
        serveDuplexOverPort(port, countBytes);
        return true;
      },
    });
    const client = multiplexPort(link.a, {
      codec: structuredCodec,
      side: "initiator",
      window: WINDOW,
    });
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    // Each small chunk leaves the sender counting a few bytes the receiver never
    // credits back (the chunk's `error: undefined`); then one close to the window waits.
    const sizes = [...Array.from({ length: 200 }, () => 10), WINDOW - 1024, 10, WINDOW - 1024];
    async function* upload() {
      for (const size of sizes) yield new Uint8Array(size).fill(7);
    }
    const run = async () => {
      for (let i = 0; i < 3; i++) {
        const port = await client.openPort();
        let answer = "";
        for await (const chunk of duplexOverPort(port)(upload())) {
          answer += new TextDecoder().decode(chunk);
        }
        expect(answer).toBe(String(sizes.reduce((a, b) => a + b, 0)));
      }
      return "done";
    };
    const stalled = new Promise((resolve) => setTimeout(() => resolve("stalled"), 5_000));
    expect(await Promise.race([run(), stalled])).toBe("done");
  }, 10_000);

  it("a windowed port sends no undefined-valued keys where the estimate reaches, so both transports deliver the same value", () => {
    const payloads: unknown[] = [
      { a: 1, b: undefined, c: { d: undefined, e: "x" } },
      {
        type: "webrun-rpc:chunk",
        channelName: "in",
        chunk: { done: false, value: new Uint8Array(10), error: undefined },
      },
      [{ a: undefined, b: [{ c: undefined, d: 1 }] }],
      Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [`k${i}`, i % 2 ? undefined : "v".repeat(i)]),
      ),
    ];
    for (const payload of payloads) {
      const sent = withoutUndefinedKeys(payload);
      // What a dropping transport delivers is what a keeping one does.
      expect(dropUndefined(sent)).toEqual(sent);
      expect(estimateMessageSize(dropUndefined(sent))).toBe(estimateMessageSize(sent));
    }
    // Nothing to drop: the payload itself, not a copy.
    const plain = { a: 1, b: "two", c: [3, 4], d: new Uint8Array(4) };
    expect(withoutUndefinedKeys(plain)).toBe(plain);
    // Values are shared, not copied; the caller's object is left as it was.
    const bytes = new Uint8Array(8);
    const chunk = { done: false, value: bytes, error: undefined };
    const out = withoutUndefinedKeys(chunk) as typeof chunk;
    expect(out.value).toBe(bytes);
    expect("error" in out).toBe(false);
    expect("error" in chunk).toBe(true);
  });
});
