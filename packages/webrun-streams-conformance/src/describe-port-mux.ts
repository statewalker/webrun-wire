import type { NativePort, NativePortMux, ValueCodec } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";

/** Two ends of one connection, from an adapter that opens a channel per port. */
export interface PortMuxHarness {
  /** A mux that opens ports and accepts none. */
  opener: NativePortMux;
  /** A mux on the other end, handing each port the opener opens to `onPort`. */
  serve(onPort: (port: NativePort) => boolean | undefined): Promise<NativePortMux>;
  /** Releases the connection. */
  dispose(): void | Promise<void>;
}

/** Builds two connected ends whose muxes use `codec`. */
export type MakePortMuxHarness = (codec: ValueCodec) => Promise<PortMuxHarness>;

/** A value whose encoding the contract's codec refuses to decode. */
const POISON = "\u0000poison";

/** JSON, except that {@link POISON} encodes to a frame `decode` rejects. */
const contractCodec: ValueCodec = {
  encode: (value) =>
    value === POISON ? new Uint8Array([0xff]) : new TextEncoder().encode(JSON.stringify(value)),
  decode: (bytes) => {
    if (bytes.byteLength === 1 && bytes[0] === 0xff) throw new Error("undecodable");
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await tick(5);
  }
}

function received(port: NativePort): unknown[] {
  const got: unknown[] = [];
  port.addEventListener("message", (e) => {
    got.push(e.data);
  });
  return got;
}

/**
 * The lifecycle every native port mux keeps (statewalker/webrun-wire#152): the
 * module (`newNativePortMux` in `@statewalker/webrun-streams`) implements it
 * once, and each transport (an in-memory one, WebRTC, libp2p) runs this suite.
 */
export function describePortMux(name: string, make: MakePortMuxHarness): void {
  async function withPair(
    body: (h: PortMuxHarness, inbound: NativePort[], server: NativePortMux) => Promise<void>,
    accept: (port: NativePort) => boolean | undefined = () => true,
  ): Promise<void> {
    const h = await make(contractCodec);
    const inbound: NativePort[] = [];
    try {
      const server = await h.serve((port) => {
        inbound.push(port);
        return accept(port);
      });
      await body(h, inbound, server);
    } finally {
      await h.opener.close().catch(() => undefined);
      await h.dispose();
    }
  }

  describe(`${name}: the native port mux contract`, () => {
    it("a port opened on one end arrives on the other; values cross both ways, encoded", () =>
      withPair(async (h, inbound) => {
        const port = await h.opener.openPort();
        const fromServer = received(port);
        port.postMessage({ n: 1, s: "a" });
        await until(() => inbound.length === 1, "the inbound port");
        const server = inbound[0] as NativePort;
        const fromClient = received(server);
        await until(() => fromClient.length === 1, "the first message");
        server.postMessage([2, "b"]);
        await until(() => fromServer.length === 1, "the answer");
        expect(fromClient).toEqual([{ n: 1, s: "a" }]);
        expect(fromServer).toEqual([[2, "b"]]);
      }));

    it("messages that arrive before a port's first listener are held, for every listener added in that tick", () =>
      withPair(async (h, inbound) => {
        const port = await h.opener.openPort();
        port.postMessage(1);
        port.postMessage(2);
        port.postMessage(3);
        await until(() => inbound.length === 1, "the inbound port");
        await tick(50);
        const server = inbound[0] as NativePort;
        const first = received(server);
        const second = received(server);
        await until(() => first.length === 3 && second.length === 3, "the held messages");
        expect(first).toEqual([1, 2, 3]);
        expect(second).toEqual([1, 2, 3]);
      }));

    it("removeEventListener stops delivery to that listener", () =>
      withPair(async (h, inbound) => {
        const port = await h.opener.openPort();
        port.postMessage("one");
        await until(() => inbound.length === 1, "the inbound port");
        const server = inbound[0] as NativePort;
        const kept: unknown[] = [];
        const dropped: unknown[] = [];
        const drop = (e: MessageEvent) => {
          dropped.push(e.data);
        };
        server.addEventListener("message", (e) => {
          kept.push(e.data);
        });
        server.addEventListener("message", drop);
        await until(() => kept.length === 1, "the first message");
        server.removeEventListener("message", drop);
        port.postMessage("two");
        await until(() => kept.length === 2, "the second message");
        expect(dropped).toEqual(["one"]);
      }));

    it("a port the serving end refuses fails: the opener's close signal aborts", () =>
      withPair(
        async (h) => {
          const port = await h.opener.openPort();
          port.postMessage("hello");
          await until(() => port.closeSignal.aborted, "the refusal");
        },
        () => false,
      ));

    it("an onPort that throws refuses the port", () =>
      withPair(
        async (h) => {
          const port = await h.opener.openPort();
          port.postMessage("hello");
          await until(() => port.closeSignal.aborted, "the refusal");
        },
        () => {
          throw new Error("onPort failed");
        },
      ));

    it("a frame the codec cannot decode fails the receiving port", () =>
      withPair(async (h, inbound) => {
        const port = await h.opener.openPort();
        port.postMessage("fine");
        await until(() => inbound.length === 1, "the inbound port");
        const server = inbound[0] as NativePort;
        received(server);
        port.postMessage(POISON);
        await until(() => server.closeSignal.aborted, "the receiving port failed");
        expect(String((server.closeSignal.reason as Error)?.message)).toMatch(/decode/);
      }));

    it("closing a port ends it on both ends", () =>
      withPair(async (h, inbound) => {
        const port = await h.opener.openPort();
        port.postMessage("hello");
        await until(() => inbound.length === 1, "the inbound port");
        await port.close();
        expect(port.closeSignal.aborted).toBe(true);
        await until(() => (inbound[0] as NativePort).closeSignal.aborted, "the peer's port closed");
      }));

    it("close() closes the ports the mux opened, and openPort rejects afterwards", () =>
      withPair(async (h) => {
        const a = await h.opener.openPort();
        const b = await h.opener.openPort();
        await h.opener.close();
        expect(a.closeSignal.aborted).toBe(true);
        expect(b.closeSignal.aborted).toBe(true);
        await expect(h.opener.openPort()).rejects.toThrow(/closed/);
      }));

    it("openPort honours its signal: aborted already, or aborted later, which closes the port", () =>
      withPair(async (h) => {
        const aborted = new AbortController();
        aborted.abort(new Error("not wanted"));
        await expect(h.opener.openPort(undefined, { signal: aborted.signal })).rejects.toThrow(
          /not wanted/,
        );
        const later = new AbortController();
        const port = await h.opener.openPort(undefined, { signal: later.signal });
        expect(port.closeSignal.aborted).toBe(false);
        later.abort(new Error("done with it"));
        await until(() => port.closeSignal.aborted, "the port closed");
      }));

    it("reports its maxMessageSize as a positive number", () =>
      withPair(async (h) => {
        expect(h.opener.maxMessageSize).toBeGreaterThan(0);
      }));
  });
}
