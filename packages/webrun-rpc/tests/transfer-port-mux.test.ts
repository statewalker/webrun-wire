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
    let calls = 0;
    let rejectedServerPort: MessageTarget | undefined;
    const acceptedSentinel: unknown[] = [];
    const server = transferPortMux(parent.port2, {
      onPort: (port) => {
        calls++;
        if (calls === 1) {
          // Capture the peer's copy of the *rejected* port without changing
          // the outcome: still return `false`.
          rejectedServerPort = port;
          return false;
        }
        // The second call, below, is accepted — it carries the sentinel
        // that gives the absence claim a real floor.
        port.addEventListener("message", (e) => {
          acceptedSentinel.push((e as MessageEvent).data);
        });
        return true;
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
    await waitFor("the peer saw the offer", () => calls === 1);

    // The genuine test: post on the rejected port's own local end. If the
    // peer actually closed its copy, this never arrives at it.
    const seenOnRejected: unknown[] = [];
    rejectedServerPort?.addEventListener("message", (e) => {
      seenOnRejected.push((e as MessageEvent).data);
    });
    rejected.postMessage("should not arrive: port was rejected");

    // The floor: a second, ACCEPTED port on the same client/server pair
    // carries a sentinel. Waiting for it to arrive replaces a bare sleep
    // with a positive signal — the two channels are independent, so this
    // ordering is practical rather than spec-guaranteed, but it is strictly
    // stronger than a sleep, and the accept path itself is independently
    // proven live by the first test in this file.
    const accepted = await client.openPort({ kind: "wanted" });
    accepted.postMessage("sentinel");
    await waitFor("the sentinel on the accepted port arrived", () => acceptedSentinel.length === 1);

    expect(seenOnRejected).toEqual([]);
    expect(calls).toBe(2);
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

    // With no `onPort` at all, there is no callback to capture the peer's
    // copy from — so the floor comes from the other end: a `MessagePort`
    // fires a `close` event when its entangled peer is closed. (Well
    // supported in Node and recent browsers, but a newer platform surface
    // than the rest of this file assumes.) Waiting for it is a positive
    // signal, in place of a bare sleep, that the rejection actually closed
    // the peer's copy — not just that nothing happened to arrive.
    let peerClosed = false;
    (local as unknown as MessagePort).addEventListener("close", () => {
      peerClosed = true;
    });
    await waitFor("the peer's copy was closed", () => peerClosed);

    const seen: unknown[] = [];
    local.addEventListener("message", (e) => {
      seen.push((e as MessageEvent).data);
    });
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

    // The mux's own `close()` also closes its underlying `target`. Handed
    // `parent.port2` directly, that would sever the parent channel entirely,
    // so a *later* transfer would go nowhere at the platform level
    // regardless of whether the mux ever detached its own listener — a
    // mutation review caught exactly that vacuity (deleting both
    // `removeEventListener` and the listener's `closed` guard left this
    // test green). Wrapping `close()` as a no-op keeps the physical channel
    // alive, so the assertions below can only pass if the mux's listener
    // really detached.
    const target: MessageTarget = {
      addEventListener: (type, listener) => parent.port2.addEventListener(type, listener),
      removeEventListener: (type, listener) => parent.port2.removeEventListener(type, listener),
      postMessage: (message, transfer) => {
        if (transfer && transfer.length > 0) parent.port2.postMessage(message, transfer);
        else parent.port2.postMessage(message);
      },
      start: () => parent.port2.start(),
    };
    const server = transferPortMux(target, {
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

    // A raw, mux-independent listener straight on the physical port: it
    // proves the channel is still alive after `server.close()`, so
    // `offered` staying put below is discriminating — not an artifact of
    // the transport itself having died.
    const rawSeen: unknown[] = [];
    parent.port2.addEventListener("message", (e) => {
      rawSeen.push((e as MessageEvent).data);
    });

    await server.close();
    await client.openPort();
    await waitFor(
      "the parent channel is still alive after server.close()",
      () => rawSeen.length === 1,
    );
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
