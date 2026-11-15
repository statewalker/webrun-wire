import {
  type NativePort,
  type NativePortMux,
  portFlow,
  type ValueCodec,
} from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";

/** The windows each end of a {@link PortWindowHarness} grants; unset is none (an older peer). */
export interface PortWindows {
  opener?: number;
  server?: number;
}

/** Two ends of one connection whose muxes may have a window (`window` on the transport's mux). */
export interface PortWindowHarness {
  /** A mux that opens ports and accepts none, with `windows.opener`. */
  opener: NativePortMux;
  /** A mux on the other end, with `windows.server`, handing each port to `onPort`. */
  serve(onPort: (port: NativePort) => boolean | undefined): Promise<NativePortMux>;
  /** Releases the connection. */
  dispose(): void | Promise<void>;
}

/** Builds two connected ends whose muxes use `codec` and the given windows. */
export type MakePortWindowHarness = (
  codec: ValueCodec,
  windows: PortWindows,
) => Promise<PortWindowHarness>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON: a string of n characters encodes to n + 2 bytes. */
const jsonCodec: ValueCodec = {
  encode: (value) => encoder.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(decoder.decode(bytes)),
};

/**
 * JSON behind one leading byte: 0xC1, the byte a windowed channel's control
 * frames start with, for a value marked `{ c1: true }`, else 0x00. A codec
 * whose frames start with that byte must still have them arrive as values.
 */
const leadingByteCodec: ValueCodec = {
  encode: (value) => {
    const json = encoder.encode(JSON.stringify(value));
    const out = new Uint8Array(json.byteLength + 1);
    out[0] = (value as { c1?: boolean } | null)?.c1 ? 0xc1 : 0x00;
    out.set(json, 1);
    return out;
  },
  decode: (bytes) => JSON.parse(decoder.decode(bytes.subarray(1))),
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

/** A listener that holds every message unconsumed until `release()`. */
function stalled(port: NativePort): { got: unknown[]; release(): void } {
  const got: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  port.addEventListener("message", (e) => {
    got.push(e.data);
    return gate;
  });
  return { got, release };
}

const agreed = (port: NativePort) => !!portFlow(port)?.agreement()?.enforced;

/**
 * Per-port flow control on native ports (statewalker/webrun-wire#153): a mux
 * given `window` grants its peer at most that many bytes of a port's messages
 * delivered and not yet consumed, where both ends speak it, and runs as before
 * against one that does not. The module (`newNativePortMux` in
 * `@statewalker/webrun-streams`) implements it once; each transport runs this
 * suite with its own negotiation.
 */
export function describePortWindow(name: string, make: MakePortWindowHarness): void {
  async function withPair(
    windows: PortWindows,
    body: (h: PortWindowHarness, inbound: NativePort[]) => Promise<void>,
    codec: ValueCodec = jsonCodec,
  ): Promise<void> {
    const h = await make(codec, windows);
    const inbound: NativePort[] = [];
    try {
      await h.serve((port) => {
        inbound.push(port);
        return true;
      });
      await body(h, inbound);
    } finally {
      await h.opener.close().catch(() => undefined);
      await h.dispose();
    }
  }

  /** A port both ends have agreed a window on, and its inbound end. */
  async function agreedPort(
    h: PortWindowHarness,
    inbound: NativePort[],
  ): Promise<{ port: NativePort; server: NativePort }> {
    const port = await h.opener.openPort();
    port.postMessage("hello");
    await until(() => inbound.length === 1, "the inbound port");
    const server = inbound[0] as NativePort;
    await until(() => agreed(port) && agreed(server), "the window agreed on both ends");
    return { port, server };
  }

  describe(`${name}: per-port windows`, () => {
    it("both ends with a window agree it: each end reports pipeline and its own window", () =>
      withPair({ opener: 8192, server: 4096 }, async (h, inbound) => {
        const { port, server } = await agreedPort(h, inbound);
        const mine = portFlow(port)?.agreement();
        const theirs = portFlow(server)?.agreement();
        expect(mine?.caps.has("pipeline")).toBe(true);
        expect(theirs?.caps.has("pipeline")).toBe(true);
        // The window an end polices is the one it grants.
        expect(mine?.window).toBe(8192);
        expect(theirs?.window).toBe(4096);
      }));

    it("control frames never reach listeners; values cross both ways intact", () =>
      withPair({ opener: 8192, server: 8192 }, async (h, inbound) => {
        const { port, server } = await agreedPort(h, inbound);
        const fromServer = received(port);
        const fromClient = received(server);
        for (let i = 0; i < 20; i++) port.postMessage({ i });
        for (let i = 0; i < 20; i++) server.postMessage([i]);
        await until(
          () => fromClient.length === 21 && fromServer.length === 20,
          "every message, both ways",
        );
        expect(fromClient).toEqual(["hello", ...Array.from({ length: 20 }, (_, i) => ({ i }))]);
        expect(fromServer).toEqual(Array.from({ length: 20 }, (_, i) => [i]));
      }));

    it("a frame whose encoding starts with the control byte still arrives as a value", () =>
      withPair(
        { opener: 8192, server: 8192 },
        async (h, inbound) => {
          const { port, server } = await agreedPort(h, inbound);
          const fromServer = received(port);
          const fromClient = received(server);
          port.postMessage({ c1: true, n: 1 });
          server.postMessage({ c1: true, n: 2 });
          await until(() => fromClient.length === 2 && fromServer.length === 1, "both values");
          expect(fromClient[1]).toEqual({ c1: true, n: 1 });
          expect(fromServer[0]).toEqual({ c1: true, n: 2 });
        },
        leadingByteCodec,
      ));

    it("a stalled consumer holds the sender to the window; consuming returns the credit", () =>
      withPair({ opener: 8192, server: 8192 }, async (h, inbound) => {
        const { port, server } = await agreedPort(h, inbound);
        const consumer = stalled(server);
        // "hello" was consumed before the listener existed: nothing is outstanding.
        await until(() => consumer.got.length === 1, "the held hello");
        consumer.got.length = 0;
        const body = "x".repeat(1000); // 1002 bytes in JSON
        for (let i = 0; i < 30; i++) port.postMessage(body);
        await tick(200);
        const flow = portFlow(port);
        // 8 messages fit 8192; the rest wait in the sender's queue.
        expect(consumer.got.length * 1002).toBeLessThanOrEqual(8192);
        expect(consumer.got.length).toBeGreaterThan(0);
        expect(flow?.bufferedAmount()).toBeGreaterThan(0);
        let drained = false;
        void flow?.ready().then(() => {
          drained = true;
        });
        consumer.release();
        await until(() => consumer.got.length === 30, "every message once consumed");
        await until(() => drained, "the sender's queue drained");
        expect(flow?.bufferedAmount()).toBe(0);
      }));

    it("a message larger than the window goes once nothing is outstanding", () =>
      withPair({ opener: 1024, server: 1024 }, async (h, inbound) => {
        const { port, server } = await agreedPort(h, inbound);
        const got = received(server);
        await until(() => got.length === 1, "the hello");
        const big = "y".repeat(5000);
        port.postMessage(big);
        port.postMessage(big);
        await until(() => got.length === 3, "both large messages");
        expect(got.slice(1)).toEqual([big, big]);
      }));

    it("closing a port sends what the window held back before the close", () =>
      withPair({ opener: 8192, server: 8192 }, async (h, inbound) => {
        const { port, server } = await agreedPort(h, inbound);
        const consumer = stalled(server);
        const body = "z".repeat(1000);
        for (let i = 0; i < 20; i++) port.postMessage(body);
        await tick(50);
        expect(portFlow(port)?.bufferedAmount()).toBeGreaterThan(0);
        await port.close();
        consumer.release();
        await until(() => consumer.got.length === 21, "every message, the held ones included");
      }));

    it("an opener with a window and a serving end without: no agreement, messages flow as before", () =>
      withPair({ opener: 1024 }, async (h, inbound) => {
        const port = await h.opener.openPort();
        port.postMessage("hello");
        await until(() => inbound.length === 1, "the inbound port");
        const server = inbound[0] as NativePort;
        const consumer = stalled(server);
        const fromServer = received(port);
        const body = "w".repeat(1000);
        for (let i = 0; i < 10; i++) port.postMessage(body);
        server.postMessage("answer");
        await until(() => consumer.got.length === 11, "every message, unwindowed");
        await until(() => fromServer.length === 1, "the answer");
        expect(fromServer).toEqual(["answer"]);
        expect(agreed(port)).toBe(false);
        expect(agreed(server)).toBe(false);
        expect(portFlow(port)?.bufferedAmount() ?? 0).toBe(0);
      }));

    it("a serving end with a window and an opener without: no agreement, messages flow as before", () =>
      withPair({ server: 1024 }, async (h, inbound) => {
        const port = await h.opener.openPort();
        const fromServer = received(port);
        port.postMessage("hello");
        await until(() => inbound.length === 1, "the inbound port");
        const server = inbound[0] as NativePort;
        const fromClient = received(server);
        const body = "v".repeat(1000);
        for (let i = 0; i < 10; i++) server.postMessage(body);
        await until(() => fromServer.length === 10, "every message, unwindowed");
        await until(() => fromClient.length === 1, "the hello");
        expect(fromServer.every((m) => m === body)).toBe(true);
        expect(agreed(port)).toBe(false);
        expect(agreed(server)).toBe(false);
      }));
  });
}
