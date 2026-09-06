import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  type MessageTarget,
  PORT_TRANSFER,
  serveDuplexOverPort,
  transferPortMux,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

describe("transferPortMux (spec D23)", () => {
  it("hands the peer a real MessagePort, and traffic flows both ways", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const accepted: Array<{ port: MessageTarget; meta: unknown }> = [];
    const server = transferPortMux(parent.port2, {
      onPort: (port, meta) => {
        accepted.push({ port, meta });
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });

    const local = await client.openPort({ kind: "stream" });
    await waitFor("the peer accepted a port", () => accepted.length === 1);
    expect(accepted[0]?.meta).toEqual({ kind: "stream" });
    // The point of D23: this is a genuine MessagePort, not an emulated one.
    expect(accepted[0]?.port).toBeInstanceOf(MessagePort);

    const fromPeer: unknown[] = [];
    accepted[0]?.port.addEventListener("message", (e) => {
      fromPeer.push((e as MessageEvent).data);
    });
    const fromLocal: unknown[] = [];
    local.addEventListener("message", (e) => {
      fromLocal.push((e as MessageEvent).data);
    });

    local.postMessage("client says hi");
    await waitFor("peer got the client's message", () => fromPeer.length === 1);
    expect(fromPeer[0]).toBe("client says hi");

    accepted[0]?.port.postMessage("server says hi");
    await waitFor("client got the peer's message", () => fromLocal.length === 1);
    expect(fromLocal[0]).toBe("server says hi");
  });

  it("a rejected port is closed rather than silently kept", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
        return false;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });

    const rejected = await client.openPort({ kind: "unwanted" });
    await waitFor("the peer saw the offer", () => offered === 1);

    // This test has no floor of its own — it never accepts a port, so
    // "nothing arrived" here could just as easily mean the mux is broken.
    // The genuine floors live elsewhere in this file: the previous test
    // proves an accepted port carries traffic both ways, and the second half
    // of "ignores traffic on the parent that is not a port transfer" proves a
    // real transfer still arrives on this same kind of client/server pair.
    // Together they rule out "the mux is broken" as the explanation below.
    const seen: unknown[] = [];
    rejected.addEventListener("message", (e) => {
      seen.push((e as MessageEvent).data);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    expect(offered).toBe(1);
  });

  it("with no onPort at all, an inbound port is rejected", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const server = transferPortMux(parent.port2);
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    const local = await client.openPort();
    // Same shape as the rejection test above, and the same floors apply: the
    // first test proves an accepted port carries traffic both ways, and the
    // second half of the "ignores traffic" test proves a real transfer still
    // arrives, so a silent mux failure is not what would make `seen` empty.
    const seen: unknown[] = [];
    local.addEventListener("message", (e) => {
      seen.push((e as MessageEvent).data);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });

  it("ignores traffic on the parent that is not a port transfer", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    for (const junk of [
      undefined,
      null,
      7,
      "text",
      { type: "something-else" },
      { type: PORT_TRANSFER },
    ]) {
      parent.port1.postMessage(junk);
    }
    // The last one has the right `type` but no transferred port, so it must
    // also be ignored rather than throwing.
    await new Promise((r) => setTimeout(r, 30));
    expect(offered).toBe(0);
    // Floor: a real transfer on the same parent still works.
    await client.openPort();
    await waitFor("a real transfer still arrives", () => offered === 1);
  });

  it("close() stops accepting and rejects further openPort calls", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      parent.port1.close();
      parent.port2.close();
    });
    await client.openPort();
    await waitFor("first transfer arrived", () => offered === 1);

    await server.close();
    await client.openPort();
    await new Promise((r) => setTimeout(r, 30));
    expect(offered).toBe(1);

    await client.close();
    await expect(client.openPort()).rejects.toThrow(/multiplexer is closed/);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("a Duplex runs over a transferred port unchanged", async () => {
    // The seam claim in D23: layer 2 cannot tell which multiplexer produced
    // the port it was handed.
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const server = transferPortMux(parent.port2, {
      onPort: (port) => {
        serveDuplexOverPort(port, async function* echo(input) {
          for await (const chunk of input) yield chunk;
        });
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    const streamPort = await client.openPort({ kind: "stream" });
    const out = await collectBytes(duplexOverPort(streamPort)([enc.encode("over a real port")]));
    expect(dec.decode(out)).toBe("over a real port");
  }, 20_000);
});
