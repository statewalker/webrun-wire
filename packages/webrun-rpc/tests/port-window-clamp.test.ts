import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import * as v010 from "webrun-rpc-0-10";
import type { MessageTarget, PortEnvelope, PortMuxOptions } from "../src/index.js";
import * as current from "../src/index.js";
import { portAgreement } from "../src/port-credit.js";

// #145: the responder bounds the window a peer's `open` asks for. It clamps
// the opener's window to its own and carries the clamped window in its ack,
// behind the `"window"` capability, so an opener that lists it adopts it and
// one that does not (any earlier version) keeps working as before.

type Kit = Pick<
  typeof current,
  "multiplexPort" | "duplexOverPort" | "serveDuplexOverPort" | "structuredCodec"
>;
const NEW = current as Kit;
const OLD = v010 as unknown as Kit;
type Mux = ReturnType<Kit["multiplexPort"]>;

const KiB = 1024;
const SMALL = 16 * KiB;
const LARGE = 1024 * KiB;

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

/** A channel whose traffic both ways is logged as it is posted. */
function tappedChannel() {
  const ch = new MessageChannel();
  const wire: { from: "a" | "b"; data: PortEnvelope }[] = [];
  const tap = (port: MessagePort, from: "a" | "b"): MessageTarget => ({
    postMessage(message: unknown, transfer?: Transferable[]) {
      wire.push({ from, data: structuredClone(message) as PortEnvelope });
      port.postMessage(message, transfer ?? []);
    },
    addEventListener: (type, listener) => port.addEventListener(type, listener as never),
    removeEventListener: (type, listener) => port.removeEventListener(type, listener as never),
    start: () => port.start(),
  });
  cleanups.push(() => {
    ch.port1.close();
    ch.port2.close();
  });
  return { a: tap(ch.port1, "a"), b: tap(ch.port2, "b"), raw: ch, wire };
}

const countBytes: Duplex = async function* (input) {
  let n = 0;
  for await (const chunk of input) n += chunk.byteLength;
  yield new TextEncoder().encode(String(n));
};

async function* upload(n: number, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < n; i++) yield new Uint8Array(size).fill(i & 0xff);
}

function pair(
  opener: { kit: Kit; window?: number; options?: Partial<PortMuxOptions> },
  responder: { kit: Kit; window?: number },
  handler: Duplex = countBytes,
) {
  const link = tappedChannel();
  const served: MessageTarget[] = [];
  const server = responder.kit.multiplexPort(link.b, {
    codec: responder.kit.structuredCodec,
    side: "responder",
    window: responder.window,
    onPort: (port: MessageTarget) => {
      served.push(port);
      responder.kit.serveDuplexOverPort(port, handler);
      return true;
    },
  } as PortMuxOptions) as Mux;
  const client = opener.kit.multiplexPort(link.a, {
    codec: opener.kit.structuredCodec,
    side: "initiator",
    window: opener.window,
    ...opener.options,
  } as PortMuxOptions) as Mux;
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { link, client, server, served };
}

async function uploadCount(kit: Kit, client: Mux, n: number, size: number): Promise<string> {
  const port = await client.openPort();
  let answer = "";
  for await (const chunk of kit.duplexOverPort(port)(upload(n, size))) {
    answer += new TextDecoder().decode(chunk);
  }
  return answer;
}

const acks = (link: ReturnType<typeof tappedChannel>) =>
  link.wire
    .filter(({ from, data }) => from === "b" && data.type === "credit" && data.bytes === 0)
    .map(({ data }) => data as Extract<PortEnvelope, { type: "credit" }>);
const opens = (link: ReturnType<typeof tappedChannel>) =>
  link.wire
    .filter(({ from, data }) => from === "a" && data.type === "open")
    .map(({ data }) => data as Extract<PortEnvelope, { type: "open" }>);

describe("new opener, new responder", () => {
  it("the responder clamps a larger window to its own and says so in the ack; both ends take it", async () => {
    const { link, client, served } = pair({ kit: NEW, window: LARGE }, { kit: NEW, window: SMALL });
    expect(opens(link)).toEqual([]);
    expect(await uploadCount(NEW, client, 200, 1000)).toBe("200000");
    expect(opens(link)[0]?.caps).toContain("window");
    expect(acks(link)[0]).toMatchObject({
      window: SMALL,
      caps: expect.arrayContaining(["window"]),
    });
    // The responder's port holds the clamped window from the open on.
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(SMALL);
  });

  it("both ends then count against the clamped window", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stalled: Duplex = async function* (input) {
      await gate;
      yield* countBytes(input);
    };
    const { client } = pair({ kit: NEW, window: LARGE }, { kit: NEW, window: SMALL }, stalled);
    const port = await client.openPort();
    const result = (async () => {
      let answer = "";
      for await (const chunk of NEW.duplexOverPort(port)(upload(200, 1000))) {
        answer += new TextDecoder().decode(chunk);
      }
      return answer;
    })();
    // The opener adopts the ack's window: its stalled upload stops there.
    await waitFor(
      () => client.ports?.().some((p) => p.window === SMALL) ?? false,
      "the opener took the clamped window",
    );
    await new Promise((r) => setTimeout(r, 50));
    for (const info of client.ports?.() ?? []) {
      expect(info.outstanding ?? 0).toBeLessThanOrEqual(SMALL);
    }
    release();
    expect(await result).toBe("200000");
  });

  it("a later presuming port opens with the window it learned, and completes", async () => {
    const { link, client } = pair({ kit: NEW, window: LARGE }, { kit: NEW, window: SMALL });
    for (let i = 0; i < 3; i++) expect(await uploadCount(NEW, client, 100, 1000)).toBe("100000");
    const [, ...later] = opens(link);
    expect(later.map((o) => o.window)).toEqual([SMALL, SMALL]);
  });

  it('with presumeAck "always", a first port that sent past the clamped window still completes where the responder accepted it', async () => {
    // Review of #178: one 32 KiB chunk passes a 16 KiB window, and the
    // responder accepts a message begun with nothing held; so must the opener.
    const { link, client } = pair(
      { kit: NEW, window: LARGE, options: { presumeAck: "always" } },
      { kit: NEW, window: SMALL },
    );
    expect(await uploadCount(NEW, client, 1, 32 * KiB)).toBe(String(32 * KiB));
    expect(await uploadCount(NEW, client, 2, 10 * KiB)).toBe(String(20 * KiB));
    for (let i = 0; i < 3; i++) expect(await uploadCount(NEW, client, 100, 1000)).toBe("100000");
    // Later opens ask for the learned window.
    expect(
      opens(link)
        .slice(1)
        .every((o) => o.window === SMALL),
    ).toBe(true);
  });

  it('with presumeAck "always", a first port that stayed within the clamped window completes', async () => {
    const { client } = pair(
      { kit: NEW, window: LARGE, options: { presumeAck: "always" } },
      { kit: NEW, window: SMALL },
    );
    expect(await uploadCount(NEW, client, 1, 1000)).toBe("1000");
  });

  it("an opener asking for less than the responder's window keeps its own", async () => {
    const { link, client, served } = pair({ kit: NEW, window: SMALL }, { kit: NEW, window: LARGE });
    expect(await uploadCount(NEW, client, 50, 1000)).toBe("50000");
    expect(acks(link)[0]?.window).toBe(SMALL);
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(SMALL);
  });

  it("a responder with no window of its own takes the opener's, as before", async () => {
    const { client, served } = pair({ kit: NEW, window: LARGE }, { kit: NEW });
    expect(await uploadCount(NEW, client, 50, 1000)).toBe("50000");
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(LARGE);
  });
});

describe("a hostile opener", () => {
  it("cannot lift the responder's window by asking for Number.MAX_SAFE_INTEGER", async () => {
    const ch = new MessageChannel();
    cleanups.push(() => {
      ch.port1.close();
      ch.port2.close();
    });
    const served: MessageTarget[] = [];
    const server = NEW.multiplexPort(ch.port2, {
      codec: NEW.structuredCodec,
      side: "responder",
      window: SMALL,
      onPort: (port) => {
        served.push(port);
        return true;
      },
    });
    cleanups.push(() => server.close());
    const received: PortEnvelope[] = [];
    ch.port1.onmessage = (event) => received.push(event.data);
    ch.port1.postMessage({
      type: "open",
      id: 0,
      window: Number.MAX_SAFE_INTEGER,
      caps: ["pipeline", "end", "window"],
    } satisfies PortEnvelope);
    await waitFor(() => received.length > 0, "the ack");
    expect(received[0]).toMatchObject({ type: "credit", id: 0, bytes: 0, window: SMALL });
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(SMALL);
  });

  it("an ack can only shrink an opener's window, never widen it", async () => {
    const ch = new MessageChannel();
    cleanups.push(() => {
      ch.port1.close();
      ch.port2.close();
    });
    const client = NEW.multiplexPort(ch.port1, {
      codec: NEW.structuredCodec,
      side: "initiator",
      window: SMALL,
      presumeAck: "never",
    });
    cleanups.push(() => client.close());
    ch.port2.onmessage = (event) => {
      const envelope = event.data as PortEnvelope;
      if (envelope.type === "open") {
        ch.port2.postMessage({
          type: "credit",
          id: envelope.id,
          bytes: 0,
          caps: ["pipeline", "end", "window"],
          window: LARGE,
        } satisfies PortEnvelope);
      }
    };
    const port = await client.openPort();
    await waitFor(() => client.ports().some((p) => p.window != null), "the ack");
    expect(client.ports()[0]?.window).toBe(SMALL);
    expect(portAgreement(port)?.window).toBe(SMALL);
  });
});

describe("mixed versions keep working", () => {
  it("an older opener (0.10, no window capability) is held to the responder's window (#202), and completes", async () => {
    const { link, client, served } = pair({ kit: OLD, window: LARGE }, { kit: NEW, window: SMALL });
    expect(await uploadCount(OLD, client, 200, 1000)).toBe("200000");
    // The ack still carries no window: an older opener would not read it.
    expect(acks(link)[0]?.window).toBeUndefined();
    expect(portAgreement(served[0] as MessageTarget)?.window).toBe(SMALL);
  });

  it("a new opener against an older responder (0.10) keeps its own window, and completes", async () => {
    const { client } = pair({ kit: NEW, window: LARGE }, { kit: OLD, window: SMALL });
    for (let i = 0; i < 3; i++) expect(await uploadCount(NEW, client, 200, 1000)).toBe("200000");
    for (const info of client.ports?.() ?? []) expect(info.window ?? LARGE).toBe(LARGE);
  });
});
