import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { multiplexPort } from "../src/multiplex-port.js";
import type { PortInfo, PortMux } from "../src/port-types.js";
import { structuredCodec } from "../src/structured-codec.js";

// #39 proposal 5: a port its consumer dropped without closing is reported
// (`onLeak`) and its slot freed, instead of holding the table forever.

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const rawPorts: MessagePort[] = [];
const muxes: PortMux[] = [];
afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((m) => m.close()));
  for (const p of rawPorts.splice(0)) p.close();
});

function pair(onLeak?: (info: PortInfo) => void) {
  const ch = new MessageChannel();
  rawPorts.push(ch.port1, ch.port2);
  const a = multiplexPort(ch.port1, { codec: structuredCodec, side: "initiator", onLeak });
  const b = multiplexPort(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    onPort: () => true,
  });
  muxes.push(a, b);
  return { a, b };
}

async function collectUntil(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    gc();
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe("a port dropped without close", () => {
  it("is reported with its meta, and its slot is freed on both ends", async () => {
    const leaks: PortInfo[] = [];
    const { a, b } = pair((info) => leaks.push(info));
    await (async () => {
      const port = await a.openPort({ kind: "leaky" });
      port.addEventListener("message", () => {});
      port.postMessage("hello");
    })();
    const reported = await collectUntil(() => leaks.length > 0 && b.ports().length === 0);
    expect(reported).toBe(true);
    expect(leaks.map((l) => l.meta)).toEqual([{ kind: "leaky" }]);
    expect(a.ports()).toEqual([]);
  });

  it("a port still held is never reported", async () => {
    const leaks: PortInfo[] = [];
    const { a } = pair((info) => leaks.push(info));
    const held = await a.openPort({ kind: "held" });
    await collectUntil(() => false, 200);
    expect(leaks).toEqual([]);
    expect(a.ports()).toHaveLength(1);
    held.close?.();
  });

  it("a port opened with a signal is still collected once dropped", async () => {
    const leaks: PortInfo[] = [];
    const { a } = pair((info) => leaks.push(info));
    const signal = new AbortController().signal; // long-lived, never aborted
    await (async () => {
      await a.openPort({ kind: "signalled" }, { signal });
    })();
    expect(await collectUntil(() => leaks.length > 0)).toBe(true);
  });
});
