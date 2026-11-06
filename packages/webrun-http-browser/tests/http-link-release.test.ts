import { afterEach, describe, expect, it } from "vitest";
import { connectHttpLink, type HttpLink, serveHttpLink } from "../src/link/http-link.js";

/**
 * A link gives every request's port back, however the exchange ends.
 *
 * Each request is one webrun-rpc call on its own multiplexed port. A port that an
 * ended exchange keeps is a leak, and a link that leaks stops: past `maxPorts`
 * the calling end refuses to open another (`maxPorts (n) reached`) and the
 * answering end refuses the call. So both ends run with a ceiling of two here,
 * and every case runs many more exchanges than that on one link: a single port
 * kept by either end fails the case within three exchanges.
 */

const MAX_PORTS = 2;
const ROUNDS = 30;

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function linked(
  handler: (request: Request) => Response | Promise<Response>,
  serveOptions: { requestIdleMs?: number } = {},
): Promise<{ link: HttpLink; stop: () => Promise<void> }> {
  const channel = new MessageChannel();
  const stop = await serveHttpLink(channel.port2, handler, {
    maxPorts: MAX_PORTS,
    ...serveOptions,
  });
  const link = await connectHttpLink(channel.port1, { maxPorts: MAX_PORTS });
  closers.push(
    () => link.close(),
    () => stop(),
    () => channel.port1.close(),
    () => channel.port2.close(),
  );
  return { link, stop };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}
const bytes = (n: number) => new Uint8Array(n).fill(1);

function chunked(count: number, size: number): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent++ === count) controller.close();
          else controller.enqueue(bytes(size));
        },
      },
      { highWaterMark: 0 },
    ),
  );
}

function endless(): Response {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(bytes(4096));
        },
      },
      { highWaterMark: 0 },
    ),
  );
}

interface Case {
  name: string;
  handler: (request: Request) => Promise<Response>;
  request: () => Request;
  consume: (response: Response) => Promise<unknown>;
  rejects?: RegExp;
}

const get = () => new Request("http://x/");

const CASES: Case[] = [
  {
    name: "GET, the body read to its end",
    handler: async () => new Response("hello"),
    request: get,
    consume: async (r) => expect(await r.text()).toBe("hello"),
  },
  {
    name: "GET, a streamed body read with a reader",
    handler: async () => chunked(8, 512),
    request: get,
    consume: async (r) => {
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      let n = 0;
      for (let c = await reader.read(); !c.done; c = await reader.read()) n += c.byteLength;
      void n;
    },
  },
  {
    name: "GET, a large body (512 KiB)",
    handler: async () => new Response(bytes(512 * 1024)),
    request: get,
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(512 * 1024),
  },
  {
    name: "GET, an empty body",
    handler: async () => new Response(""),
    request: get,
    consume: async (r) => expect(await r.text()).toBe(""),
  },
  {
    name: "GET, 404 with a body",
    handler: async () => new Response("nope", { status: 404 }),
    request: get,
    consume: async (r) => expect(await r.text()).toBe("nope"),
  },
  {
    name: "HEAD",
    handler: async () => new Response("ignored"),
    request: () => new Request("http://x/", { method: "HEAD" }),
    consume: async (r) => expect(r.body).toBeNull(),
  },
  {
    name: "OPTIONS",
    handler: async () => new Response(null, { headers: { allow: "GET" } }),
    request: () => new Request("http://x/", { method: "OPTIONS" }),
    consume: async () => {},
  },
  {
    name: "204",
    handler: async () => new Response(null, { status: 204 }),
    request: get,
    consume: async (r) => expect(r.status).toBe(204),
  },
  {
    name: "304",
    handler: async () => new Response(null, { status: 304 }),
    request: get,
    consume: async (r) => expect(r.status).toBe(304),
  },
  {
    name: "POST, the handler reads the body",
    handler: async (q) => new Response(await q.text()),
    request: () => new Request("http://x/", { method: "POST", body: "payload" }),
    consume: async (r) => expect(await r.text()).toBe("payload"),
  },
  {
    name: "POST, the handler ignores the body",
    handler: async () => new Response("ok"),
    request: () => new Request("http://x/", { method: "POST", body: bytes(64 * 1024) }),
    consume: async (r) => expect(await r.text()).toBe("ok"),
  },
  {
    name: "PUT, a streamed request body echoed back",
    handler: async (q) => new Response(q.body),
    request: () => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 4) c.close();
          else c.enqueue(bytes(1000));
        },
      });
      return new Request("http://x/", { method: "PUT", body, duplex: "half" } as RequestInit);
    },
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(4000),
  },
  {
    name: "the body cancelled before any read",
    handler: async () => endless(),
    request: get,
    consume: async (r) => r.body?.cancel(),
  },
  {
    name: "the body cancelled after one chunk",
    handler: async () => endless(),
    request: get,
    consume: async (r) => {
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.cancel();
    },
  },
  {
    name: "the handler throws",
    handler: async () => {
      throw new Error("handler blew up");
    },
    request: get,
    consume: async () => {},
    rejects: /handler blew up/,
  },
  {
    name: "the response body fails mid-stream",
    handler: async () => {
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ === 2) c.error(new Error("producer failed"));
            else c.enqueue(bytes(16));
          },
        }),
      );
    },
    request: get,
    consume: async (r) => r.text(),
    rejects: /./,
  },
];

describe("a link gives every request's port back", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { link } = await linked(c.handler);
      for (let i = 0; i < ROUNDS; i++) {
        const run = async () => c.consume(await link.send(c.request()));
        if (c.rejects) await expect(run(), `exchange ${i + 1}`).rejects.toThrow(c.rejects);
        else await run();
        await settle();
        expect(link.inflight, `requests in flight after exchange ${i + 1}`).toBe(0);
      }
      // The link still takes as many requests at once as its ceiling: none is
      // refused for want of a port (a throwing handler still answers with its error).
      const probes = await Promise.allSettled(
        Array.from({ length: MAX_PORTS }, () => link.send(c.request()).then(c.consume)),
      );
      for (const p of probes)
        if (p.status === "rejected")
          expect(String(p.reason)).not.toMatch(/maxPorts|max-ports|rejected/);
    });
  }

  it("an abort while the head is awaited gives the port back once answered", async () => {
    const answers: Array<() => void> = [];
    const { link } = await linked(async () => {
      await new Promise<void>((r) => answers.push(r));
      return new Response("late");
    });
    for (let i = 0; i < ROUNDS; i++) {
      const controller = new AbortController();
      const pending = link.send(new Request("http://x/", { signal: controller.signal }));
      while (answers.length === 0) await tick();
      controller.abort(new Error("gave up"));
      await expect(pending).rejects.toThrow("gave up");
      answers.shift()?.();
      await settle();
    }
    expect(link.inflight).toBe(0);
  });

  it("the request aborted mid-body gives the port back", async () => {
    const { link } = await linked(async () => endless());
    for (let i = 0; i < ROUNDS; i++) {
      const controller = new AbortController();
      const response = await link.send(new Request("http://x/", { signal: controller.signal }));
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      controller.abort();
      await expect(reader.read()).rejects.toThrow();
      await settle();
    }
    expect(link.inflight).toBe(0);
  });

  it("as many requests at once as the ceiling allows, round after round", async () => {
    const { link } = await linked(async (q) => new Response(new URL(q.url).pathname));
    for (let round = 0; round < ROUNDS; round++) {
      const texts = await Promise.all(
        Array.from({ length: MAX_PORTS }, (_, i) =>
          link.send(new Request(`http://x/${round}-${i}`)).then((r) => r.text()),
        ),
      );
      expect(texts).toEqual([`/${round}-0`, `/${round}-1`]);
      await settle();
    }
    expect(link.inflight).toBe(0);
    await link.whenIdle();
  });

  it("past the ceiling, a request fails rather than queueing (the ceiling is real)", async () => {
    const { link } = await linked(async () => endless());
    const held = await Promise.all(
      Array.from({ length: MAX_PORTS }, () => link.send(new Request("http://x/"))),
    );
    await expect(link.send(new Request("http://x/"))).rejects.toThrow(/maxPorts/);
    for (const r of held) await r.body?.cancel();
    await settle();
    expect(await (await link.send(new Request("http://x/", { method: "HEAD" }))).status).toBe(200);
  });

  it("closing a link mid-request releases it: requests in flight fail, nothing stays", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { link } = await linked(async () => endless());
      const response = await link.send(new Request("http://x/"));
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await link.close();
      await expect(reader.read()).rejects.toThrow();
      expect(link.inflight).toBe(0);
      await expect(link.send(new Request("http://x/"))).rejects.toThrow(/closed/);
    }
  });
  it("a handler that answers first and reads the upload afterwards gets all of it", async () => {
    const received: number[] = [];
    const { link } = await linked(async (q) => {
      void q.arrayBuffer().then(
        (b) => received.push(b.byteLength),
        () => received.push(-1),
      );
      return new Response("accepted", { status: 202 });
    });
    for (let i = 0; i < ROUNDS; i++) {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await tick(2);
          if (n++ === 5) c.close();
          else c.enqueue(bytes(10));
        },
      });
      const r = await link.send(
        new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit),
      );
      expect([r.status, await r.text()]).toEqual([202, "accepted"]);
      // The exchange holds its port until the upload is in; the next one waits.
      for (let k = 0; k < 200 && received.length <= i; k++) await tick(5);
      await settle();
    }
    expect(received).toEqual(Array(ROUNDS).fill(50));
    await settle();
    expect(link.inflight).toBe(0);
  });

  it("204 to an upload the handler reads afterwards: all of it arrives", async () => {
    const received: number[] = [];
    const { link } = await linked(async (q) => {
      void q.arrayBuffer().then(
        (b) => received.push(b.byteLength),
        () => received.push(-1),
      );
      return new Response(null, { status: 204 });
    });
    for (let i = 0; i < ROUNDS; i++) {
      const r = await link.send(new Request("http://x/", { method: "PUT", body: bytes(70_000) }));
      expect(r.status).toBe(204);
      for (let k = 0; k < 200 && received.length <= i; k++) await tick(5);
      await settle();
    }
    expect(received).toEqual(Array(ROUNDS).fill(70_000));
  });
  it("an abort against a handler that never answers gives the port back at once", async () => {
    let started = 0;
    const { link } = await linked(async () => {
      started++;
      return await new Promise<Response>(() => {});
    });
    for (let i = 0; i < ROUNDS; i++) {
      const controller = new AbortController();
      const pending = link.send(new Request("http://x/", { signal: controller.signal }));
      for (let k = 0; k < 100 && started <= i; k++) await tick(2);
      controller.abort(new Error("gave up"));
      await expect(pending, `round ${i + 1}`).rejects.toThrow("gave up");
    }
    expect(started).toBe(ROUNDS);
    expect(link.inflight).toBe(0);
  });
  describe("a handler that takes the request body and stops reading it", () => {
    const upload = () => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await tick(2);
          if (n++ === 5) c.close();
          else c.enqueue(bytes(10));
        },
      });
      return new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
    };
    const takers: Record<string, (q: Request) => Promise<void>> = {
      "a reader dropped after one read": async (q) => {
        await (q.body as ReadableStream<Uint8Array>).getReader().read();
      },
      "a reader released after one read": async (q) => {
        const reader = (q.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        reader.releaseLock();
      },
      "a reader taken, nothing read": async (q) => {
        (q.body as ReadableStream<Uint8Array>).getReader();
      },
      "a clone, neither branch read": async (q) => {
        void q.clone();
      },
      "a clone nobody reads, the original read": async (q) => {
        void q.clone();
        await (q.body as ReadableStream<Uint8Array>).getReader().read();
      },
    };
    for (const [name, take] of Object.entries(takers)) {
      it(`${name}: the exchange ends once the body sat unread for requestIdleMs`, async () => {
        const { link } = await linked(
          async (q) => {
            await take(q);
            return new Response("ok");
          },
          { requestIdleMs: 50 },
        );
        for (let i = 0; i < ROUNDS / 3; i++) {
          const r = await link.send(upload());
          expect(await r.text(), `round ${i + 1}`).toBe("ok");
          // The exchange holds its port until the body has sat unread that long.
          await tick(120);
        }
        // Every round got a port: none was kept by an exchange left hanging.
        expect(link.inflight).toBe(0);
      });
    }

    it("a slow reader that keeps reading keeps its upload past requestIdleMs", async () => {
      const received: number[] = [];
      const { link } = await linked(
        async (q) => {
          void (async () => {
            const reader = (q.body as ReadableStream<Uint8Array>).getReader();
            let n = 0;
            for (let c = await reader.read(); !c.done; c = await reader.read()) {
              n += c.value.byteLength;
              await tick(30); // slower than the client, under requestIdleMs each time
            }
            received.push(n);
          })().catch(() => received.push(-1));
          return new Response("accepted", { status: 202 });
        },
        { requestIdleMs: 60 },
      );
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 8) c.close();
          else c.enqueue(bytes(10));
        },
      });
      const r = await link.send(
        new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit),
      );
      expect(await r.text()).toBe("accepted");
      for (let k = 0; k < 200 && received.length === 0; k++) await tick(10);
      expect(received).toEqual([80]);
    });
  });
  it("an abort after the response was read ends an exchange the peer would keep", async () => {
    // The handler holds the request body forever (no idle bound): only the
    // client's abort can end the exchange.
    const { link } = await linked(
      async (q) => {
        (q.body as ReadableStream<Uint8Array>).getReader();
        return new Response("ok");
      },
      { requestIdleMs: Number.POSITIVE_INFINITY },
    );
    for (let i = 0; i < ROUNDS / 3; i++) {
      const controller = new AbortController();
      const r = await link.send(
        new Request("http://x/", { method: "POST", body: "x", signal: controller.signal }),
      );
      expect(await r.text(), `round ${i + 1}`).toBe("ok");
      controller.abort();
      await settle();
    }
    expect(link.inflight).toBe(0);
  });
});
