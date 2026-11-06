import { afterEach, describe, expect, it } from "vitest";
import { getPortCloseSignal } from "../src/close-signal.js";
import type { MessageTarget } from "../src/message-target.js";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortEnvelope, PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";
import { transferPortMux } from "../src/transfer-port-mux.js";

// Review of #42: a port's slot is free when its close signal fires; transferPortMux keeps no
// listener on a reused signal; mux.close() tells the peer about every port exactly once; the
// maxPorts error names "none" when no port is open.

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];
afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((m) => m.close()));
  for (const p of rawPorts.splice(0)) p.close();
});

function pair(maxPorts?: number) {
  const ch = new MessageChannel();
  rawPorts.push(ch.port1, ch.port2);
  const sent: PortEnvelope[] = [];
  const codec = {
    post(port: MessageTarget, envelope: PortEnvelope, transfer?: Transferable[]) {
      sent.push(envelope);
      structuredCodec.post(port, envelope, transfer);
    },
    read: (e: MessageEvent) => structuredCodec.read(e),
  };
  const a = multiplexPort(ch.port1, { codec, side: "initiator", maxPorts });
  const b = multiplexPort(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    onPort: () => true,
  });
  muxes.push(a, b);
  return { a, sent };
}

describe("review of #42", () => {
  it("a close-signal listener can reopen within a full table, with the close's reason", async () => {
    const { a } = pair(1);
    const first = await a.openPort({ kind: "x" });
    let reopened: MessageTarget | undefined;
    let reason: unknown;
    getPortCloseSignal(first)?.addEventListener("abort", (e) => {
      reason = (e.target as AbortSignal).reason;
      void a.openPort({ kind: "x" }).then((p) => {
        reopened = p;
      });
    });
    first.close?.("reconnect");
    await new Promise((r) => setTimeout(r, 10));
    expect(reason).toBe("reconnect");
    expect(reopened).toBeDefined();
  });

  it("transferPortMux removes its listener from a reused signal when a port closes", async () => {
    const ch = new MessageChannel();
    rawPorts.push(ch.port1, ch.port2);
    ch.port1.start();
    const mux = transferPortMux(ch.port1);
    muxes.push(mux);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    }) as typeof remove;
    for (let i = 0; i < 50; i++) {
      const p = await mux.openPort(undefined, { signal: controller.signal });
      p.close?.();
    }
    expect(listeners).toBe(0);
    await mux.openPort(undefined, { signal: controller.signal });
    await mux.close();
    expect(listeners).toBe(0);
  });

  it("mux.close() tells the peer about every port once, even one a close-signal listener closed", async () => {
    const { a, sent } = pair();
    const one = await a.openPort();
    const two = await a.openPort();
    getPortCloseSignal(one)?.addEventListener("abort", () => two.close?.());
    await a.close();
    const closes = sent.filter((e) => e.type === "close").map((e) => e.id);
    expect(closes.length).toBe(new Set(closes).size); // none twice
    expect(closes.sort()).toEqual([0, 2]); // and both ports told
  });

  it("the maxPorts error says none are open when the table is empty", async () => {
    const { a } = pair(0);
    await expect(a.openPort()).rejects.toThrow(/open ports by kind: none/);
  });
});
