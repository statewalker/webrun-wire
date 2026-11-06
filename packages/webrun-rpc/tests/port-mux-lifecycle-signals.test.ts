import { afterEach, describe, expect, it } from "vitest";
import { getPortCloseSignal } from "../src/close-signal.js";
import { connect, overPipe, serve } from "../src/connect-serve.js";
import type { MessageTarget } from "../src/message-target.js";
import { MUX_CLOSED_MESSAGE, multiplexPort } from "../src/multiplex-port.js";
import type { PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];

function pair(options: { signal?: AbortSignal; maxPorts?: number } = {}) {
  const channel = new MessageChannel();
  rawPorts.push(channel.port1, channel.port2);
  const accepted: MessageTarget[] = [];
  const a = multiplexPort(channel.port1, { codec: structuredCodec, side: "initiator", ...options });
  const b = multiplexPort(channel.port2, {
    codec: structuredCodec,
    side: "responder",
    onPort: (port) => {
      accepted.push(port);
      return true;
    },
  });
  muxes.push(a, b);
  return { a, b, accepted };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
  for (const port of rawPorts.splice(0)) port.close();
});

describe("close(reason)", () => {
  it("aborts every port's close signal with the given reason", async () => {
    const { a } = pair();
    const port = await a.openPort();
    const reason = new Error("transport gone");
    await a.close(reason);
    expect(getPortCloseSignal(port)?.reason).toBe(reason);
  });

  it("keeps MUX_CLOSED_MESSAGE when no reason is given", async () => {
    const { a } = pair();
    const port = await a.openPort();
    await a.close();
    expect((getPortCloseSignal(port)?.reason as Error | undefined)?.message).toBe(
      MUX_CLOSED_MESSAGE,
    );
  });
});

describe("the transport signal", () => {
  it("closes the mux on abort: ports' signals abort with the reason and the table empties", async () => {
    const transport = new AbortController();
    const { a, b } = pair({ signal: transport.signal });
    const ports = await Promise.all([a.openPort(), a.openPort(), a.openPort()]);
    await waitFor(() => b.ports?.().length === 3, "peer sees three ports");

    const reason = new Error("connection closed");
    transport.abort(reason);

    for (const port of ports) expect(getPortCloseSignal(port)?.reason).toBe(reason);
    expect(a.ports?.()).toEqual([]);
    await expect(a.openPort()).rejects.toThrow(/closed/);
    // The peer is told, as on an explicit close, and frees its ids too.
    await waitFor(() => b.ports?.().length === 0, "peer frees its ports");
  });

  it("a pre-aborted signal yields a closed mux", async () => {
    const { a } = pair({ signal: AbortSignal.abort(new Error("already gone")) });
    await expect(a.openPort()).rejects.toThrow(/closed/);
  });

  it("fails a call in flight over overPipe({ signal }) instead of hanging", async () => {
    const channel = new MessageChannel();
    rawPorts.push(channel.port1, channel.port2);
    const transport = new AbortController();
    const stop = await serve(
      { mux: overPipe(channel.port2, { codec: structuredCodec, side: "responder" }) },
      (input) =>
        (async function* () {
          yield new Uint8Array([1]);
          for await (const _ of input);
          await new Promise(() => {});
        })(),
    );
    const client = await connect({
      mux: overPipe(channel.port1, {
        codec: structuredCodec,
        side: "initiator",
        signal: transport.signal,
      }),
    });
    async function* input() {
      yield new Uint8Array([0]);
      await new Promise(() => {});
    }
    const out = client.call(input())[Symbol.asyncIterator]();
    expect((await out.next()).value).toEqual(new Uint8Array([1]));
    const pending = out.next();
    transport.abort(new Error("connection closed"));
    await expect(pending).rejects.toThrow();
    await stop();
  });
});

describe("a port tied to its user", () => {
  it("openPort(meta, { signal }) closes the port on abort, on both ends", async () => {
    const { a, b, accepted } = pair();
    const user = new AbortController();
    const port = await a.openPort({ kind: "x" }, { signal: user.signal });
    await waitFor(() => accepted.length === 1, "peer accepts");
    user.abort();
    expect(getPortCloseSignal(port)?.aborted).toBe(true);
    expect(a.ports?.()).toEqual([]);
    await waitFor(() => b.ports?.().length === 0, "peer frees the id");
  });

  it("a port is disposable: `using` closes it on scope exit", async () => {
    const { a, b, accepted } = pair();
    {
      using port = (await a.openPort()) as MessageTarget & Disposable;
      await waitFor(() => accepted.length === 1, "peer accepts");
      expect(port).toBeDefined();
    }
    expect(a.ports?.()).toEqual([]);
    await waitFor(() => b.ports?.().length === 0, "peer frees the id");
  });
});

describe("leaks are visible", () => {
  it("ports() lists open ports with their meta, and drops closed ones", async () => {
    const { a } = pair();
    const before = Date.now();
    const p1 = await a.openPort({ kind: "http" });
    await a.openPort({ kind: "ws" });
    const listed = a.ports?.() ?? [];
    expect(listed.map((p) => p.meta)).toEqual([{ kind: "http" }, { kind: "ws" }]);
    for (const p of listed) expect(p.openedAt).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    p1.postMessage("ping");
    const [first] = a.ports?.() ?? [];
    expect(first?.lastActivity).toBeGreaterThan(first?.openedAt ?? Infinity);
    await p1.close?.();
    expect(a.ports?.().map((p) => p.meta)).toEqual([{ kind: "ws" }]);
  });

  it("the maxPorts error names the most common kinds among open ports", async () => {
    const { a } = pair({ maxPorts: 3 });
    await a.openPort({ kind: "http" });
    await a.openPort({ kind: "http" });
    await a.openPort({ kind: "ws" });
    await expect(a.openPort({ kind: "http" })).rejects.toThrow(/http: 2.*ws: 1/);
  });
});

describe("review fixes (#42)", () => {
  it("a transport abort whose pipe.close() rejects is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const transport = new AbortController();
      const pipe: MessageTarget = {
        addEventListener() {},
        removeEventListener() {},
        postMessage() {},
        close: () => Promise.reject(new Error("stream already reset")),
      };
      multiplexPort(pipe, { codec: structuredCodec, signal: transport.signal });
      transport.abort(new Error("gone"));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a port opened from a close-signal listener during close is refused, not leaked", async () => {
    const { a } = pair();
    const port = await a.openPort();
    let reopened: Promise<unknown> | undefined;
    getPortCloseSignal(port)?.addEventListener("abort", () => {
      reopened = a.openPort().catch((error) => error);
    });
    await a.close();
    expect(await reopened).toBeInstanceOf(Error);
    expect(a.ports()).toEqual([]);
  });

  it("openPort's signal reason reaches the port's close signal", async () => {
    const { a } = pair();
    const user = new AbortController();
    const port = await a.openPort(undefined, { signal: user.signal });
    const reason = new Error("user gave up");
    user.abort(reason);
    expect(getPortCloseSignal(port)?.reason).toBe(reason);
  });

  it("openPort with an already-aborted signal rejects with its reason and opens nothing", async () => {
    const { a, b } = pair();
    const reason = new Error("too late");
    await expect(a.openPort(undefined, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await new Promise((r) => setTimeout(r, 10));
    expect(a.ports()).toEqual([]);
    expect(b.ports()).toEqual([]);
  });

  it("transferPortMux honours openPort's signal too", async () => {
    const { transferPortMux } = await import("../src/transfer-port-mux.js");
    const channel = new MessageChannel();
    rawPorts.push(channel.port1, channel.port2);
    const server = transferPortMux(channel.port2, { onPort: () => true });
    const client = transferPortMux(channel.port1);
    muxes.push(server, client);
    const user = new AbortController();
    const port = (await client.openPort(undefined, { signal: user.signal })) as MessagePort;
    let closed = false;
    const close = port.close.bind(port);
    port.close = () => {
      closed = true;
      close();
    };
    user.abort();
    expect(closed).toBe(true);
  });
});
