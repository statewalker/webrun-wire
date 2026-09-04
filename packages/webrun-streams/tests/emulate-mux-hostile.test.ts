import { describe, expect, it } from "vitest";
import { type ByteChannel, collectBytes, emulateMux } from "../src/index.js";

const utf8 = new TextEncoder();
const dec = new TextDecoder();

/**
 * A pipe pair that also lets a test inject arbitrary bytes into either
 * direction, standing in for a corrupt or hostile peer. `handleFrame` parses
 * these bytes before it knows which stream they belong to, so a failure there
 * escapes to the inbound loop and reaches `failAll` — which would tear down
 * every stream sharing the mux. Each case below therefore asserts not just
 * that nothing threw, but that legitimate traffic still flows afterwards.
 */
function injectablePair(): {
  a: ByteChannel;
  b: ByteChannel;
  injectToB: (bytes: Uint8Array) => void;
  sentToA: Uint8Array[];
} {
  const qa: Uint8Array[] = [];
  const qb: Uint8Array[] = [];
  let pa: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let pb: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  const sentToA: Uint8Array[] = [];
  const deliver = (t: "a" | "b", bytes: Uint8Array): void => {
    if (t === "a") sentToA.push(bytes);
    const q = t === "a" ? qa : qb;
    const p = t === "a" ? pa : pb;
    if (p) {
      if (t === "a") pa = null;
      else pb = null;
      p({ value: bytes, done: false });
    } else q.push(bytes);
  };
  const recv = (t: "a" | "b"): AsyncIterable<Uint8Array> =>
    ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const q = t === "a" ? qa : qb;
          if (q.length) return Promise.resolve({ value: q.shift() as Uint8Array, done: false });
          return new Promise<IteratorResult<Uint8Array>>((r) => {
            if (t === "a") pa = r;
            else pb = r;
          });
        },
      }),
    }) as AsyncIterable<Uint8Array>;
  return {
    a: {
      send: (x) => deliver("b", x),
      recv: recv("a"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
    b: {
      send: (x) => deliver("a", x),
      recv: recv("b"),
      closed: new Promise<void>(() => {}),
      close: () => {},
    },
    injectToB: (bytes) => deliver("b", bytes),
    sentToA,
  };
}

/**
 * Round-trip a call, but surface a dead mux as an assertion rather than a
 * suite timeout. When a hostile frame kills the mux the call neither resolves
 * nor rejects promptly, and a bare `await` would just hang for the default
 * timeout — which reads as a flaky test rather than the denial of service it
 * actually is.
 */
async function roundTrip(call: (input: Uint8Array[]) => AsyncGenerator<Uint8Array>, text: string) {
  return Promise.race([
    collectBytes(call([utf8.encode(text)])).then(
      (out) => dec.decode(out),
      (err) => `mux is dead: ${(err as Error).message}`,
    ),
    new Promise<string>((r) => setTimeout(() => r("mux is dead: call never completed"), 300)),
  ]);
}

const HOSTILE: [string, Uint8Array][] = [
  ["truncated varint (continuation never ends)", new Uint8Array([0x80, 0x80])],
  ["over-long varint (shift past 28)", new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01])],
  ["varint consumes the frame, no type byte", new Uint8Array([0x80, 0x01])],
  ["empty frame", new Uint8Array([])],
  ["one-byte frame", new Uint8Array([0x02])],
  ["unknown type 0x00", new Uint8Array([0x02, 0x00])],
  ["unknown type 0x07", new Uint8Array([0x02, 0x07])],
  ["unknown type 0xff", new Uint8Array([0x02, 0xff])],
  ["DATA for an unknown stream id", new Uint8Array([0x63, 0x02, 0x41, 0x42])],
  ["ACK for an unknown stream id", new Uint8Array([0x63, 0x03])],
  ["END for an unknown stream id", new Uint8Array([0x63, 0x04])],
  ["CLOSE for an unknown stream id", new Uint8Array([0x63, 0x06])],
  ["ERROR for an unknown stream id", new Uint8Array([0x63, 0x05, 0x7b, 0x7d])],
  ["ERROR carrying non-JSON garbage", new Uint8Array([0x01, 0x05, 0xff, 0xfe, 0xfd])],
  ["OPEN with id 0", new Uint8Array([0x00, 0x01])],
  ["DATA with an empty payload", new Uint8Array([0x02, 0x02])],
];

describe("handleFrame survives hostile frames", () => {
  it.each(HOSTILE)("%s", async (_name, frame) => {
    const { a, b, injectToB } = injectablePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    injectToB(frame);
    await new Promise((r) => setTimeout(r, 10));

    // The real assertion: the mux is still usable after the hostile frame.
    expect(await roundTrip(client.call, "still-works")).toBe("still-works");

    await client.close();
    await server.close();
  });

  it("survives a burst of mixed garbage", async () => {
    const { a, b, injectToB } = injectablePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    for (const [, frame] of HOSTILE) injectToB(frame);
    for (let i = 0; i < 50; i++) {
      injectToB(new Uint8Array([0x80 | (i & 0x7f), 0x80, 0x80]));
    }
    await new Promise((r) => setTimeout(r, 20));

    expect(await roundTrip(client.call, "after-burst")).toBe("after-burst");

    await client.close();
    await server.close();
  });

  it("caps what one undrained stream may buffer, and spares the rest of the mux", async () => {
    // Credit is voluntary: the peer is meant to spend only what it was
    // granted and wait for more. A hostile peer does not, and pushes are
    // fire-and-forget, so without a cap one stream retains everything sent.
    const { a, b, injectToB, sentToA } = injectablePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 256 * 1024 });
    let invocations = 0;
    server.serve(async function* maybeStalled(input) {
      invocations += 1;
      if (invocations === 1) {
        // The flooded stream: never drains `input`, which is what lets the
        // inbound queue grow. Later streams echo normally, so the control
        // call below measures the mux rather than this handler.
        await new Promise((r) => setTimeout(r, 5_000));
        return;
      }
      for await (const chunk of input) yield chunk;
    });

    injectToB(new Uint8Array([0x03, 0x01])); // OPEN id 3
    await new Promise((r) => setTimeout(r, 10));
    expect(invocations).toBe(1);

    // 40 x 64 KiB with no ACK ever returned: 2.5 MiB against a 256 KiB cap.
    for (let i = 0; i < 40; i++) {
      const frame = new Uint8Array(2 + 64 * 1024);
      frame[0] = 0x03;
      frame[1] = 0x02; // DATA
      injectToB(frame);
    }
    await new Promise((r) => setTimeout(r, 30));

    // The cap fired: the flooded stream was refused with an ERROR frame.
    const TYPE_ERROR = 0x05;
    const refusal = sentToA.find((f) => f[0] === 0x03 && f[1] === TYPE_ERROR);
    expect(refusal, "expected an ERROR frame tearing down the flooded stream").toBeDefined();
    expect(dec.decode((refusal as Uint8Array).subarray(2))).toMatch(/maxStreamBuffer/);

    // The peer was handed the whole window and ignored it. Exactly one
    // credit-bearing ACK went out — the reply to its OPEN, carrying the
    // responder's 256 KiB `maxStreamBuffer` — and no drain grant followed,
    // because the handler never drained. So the cap is what stopped the
    // flood, not flow control: a peer that honours credit could never have
    // sent more than that one advertisement.
    const TYPE_ACK = 0x03;
    const grants = sentToA.filter((f) => f[0] === 0x03 && f[1] === TYPE_ACK);
    expect(grants.length).toBe(1);
    const advertised = grants[0] as Uint8Array;
    expect(advertised.byteLength).toBe(6);
    expect(new DataView(advertised.buffer, advertised.byteOffset + 2, 4).getUint32(0, false)).toBe(
      256 * 1024,
    );

    // And only that stream: the mux still serves everyone else.
    expect(await roundTrip(client.call, "unaffected")).toBe("unaffected");

    await client.close();
    await server.close();
  });

  it("ignores a duplicate OPEN for a live stream without disturbing the mux", async () => {
    const { a, b, injectToB } = injectablePair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder" });
    let opens = 0;
    server.serve(async function* counting(input) {
      opens += 1;
      for await (const chunk of input) yield chunk;
    });

    injectToB(new Uint8Array([0x05, 0x01])); // OPEN id 5
    await new Promise((r) => setTimeout(r, 10));
    injectToB(new Uint8Array([0x05, 0x01])); // same id again, stream still live
    await new Promise((r) => setTimeout(r, 10));

    expect(opens).toBe(1);
    // And a forged id does not lock the peer out of its own later streams.
    expect(await roundTrip(client.call, "alive")).toBe("alive");

    await client.close();
    await server.close();
  });
});
