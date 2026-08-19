import { once } from "node:events";
import {
  type AddressInfo,
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";

/**
 * Bodiless-status regression test (ledger R27): `fetchOverDuplex` used to
 * unconditionally wrap the response body, so `new Response(body, { status })`
 * threw for 101/103/204/205/304 and HEAD/OPTIONS carried a body they
 * shouldn't. This exercises the fix over a *real* Duplex pair — two live TCP
 * sockets, not the direct-call loopback other tests in this package use —
 * so the request and response genuinely cross an async/wire boundary.
 */

async function* socketToBytes(socket: Socket): AsyncGenerator<Uint8Array> {
  for await (const chunk of socket as unknown as AsyncIterable<Buffer>) {
    yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

async function writeAll(socket: Socket, input: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of input) {
    if (!socket.write(chunk)) await once(socket, "drain");
  }
}

/** Wrap a live TCP socket as a `Duplex`: write `input` out, yield what comes back. */
function socketDuplex(socket: Socket): Duplex {
  return (input) => {
    const output = socketToBytes(socket);
    writeAll(socket, input).catch(() => {
      /* the read side surfaces any real failure */
    });
    return output;
  };
}

describe("fetchOverDuplex / serveFetchOverDuplex — bodiless statuses (real Duplex over TCP)", () => {
  let server: ReturnType<typeof createNetServer> | undefined;
  let client: Socket | undefined;

  afterEach(async () => {
    client?.destroy();
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
    client = undefined;
  });

  async function connectTo(
    handler: (request: Request) => Promise<Response>,
  ): Promise<{ call: Duplex }> {
    server = createNetServer((socket) => {
      const handlerDuplex = serveFetchOverDuplex(handler);
      const input = socketToBytes(socket);
      const output = handlerDuplex(input);
      writeAll(socket, output).catch(() => {
        /* client disconnect races the write; not the thing under test */
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    client = netConnect(port, "127.0.0.1");
    await once(client, "connect");
    return { call: socketDuplex(client) };
  }

  it.each([
    204, 205, 304,
  ])("a %d response round-trips with a null body, draining the handler's stream", async (status) => {
    // The Fetch API itself refuses a body for these statuses at
    // construction time, so the handler cannot hand back a populated
    // stream here — the null-body enforcement this test guards against is
    // in `fetchOverDuplex`'s reconstruction of the *response* on the wire.
    const { call } = await connectTo(async () => new Response(null, { status }));

    const response = await fetchOverDuplex(call, new Request("http://peer.local/thing"));

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    const text = await response.text();
    expect(text).toBe("");
  });

  it("a HEAD response round-trips with no body even for a 200 status", async () => {
    const { call } = await connectTo(async () => {
      return new Response("this is body content that HEAD must not deliver", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const response = await fetchOverDuplex(
      call,
      new Request("http://peer.local/thing", { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    const text = await response.text();
    expect(text).toBe("");
  });

  it("a normal 200 GET still streams its body over the same pair", async () => {
    const { call } = await connectTo(async () => new Response("hello wire", { status: 200 }));

    const response = await fetchOverDuplex(call, new Request("http://peer.local/thing"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello wire");
  });
});
