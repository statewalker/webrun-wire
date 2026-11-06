import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";
import { httpFetch, httpServe } from "../src/http-data.js";

/**
 * Every exchange ends its call, however it ends.
 *
 * A call is one `Duplex` invocation, and on a multiplexed transport (webrun-rpc's
 * `connect`) the call's generator reaching its `finally` is what frees the call's
 * port. An exchange whose call never ends holds one port for good, and the
 * multiplexer refuses new calls once `maxPorts` of them pile up. So each case here
 * asserts that no call is left open — the call's generator has finished — once the
 * caller is done with the response, whichever way it was done: read to its end,
 * left early, never started, refused, failed, aborted.
 */

/** A call that counts the invocations whose generator has not finished yet. */
function tracked(inner: Duplex): { call: Duplex; open(): number; started(): number } {
  let open = 0;
  let started = 0;
  const call: Duplex = (input) =>
    (async function* () {
      open++;
      started++;
      try {
        yield* inner(input);
      } finally {
        open--;
      }
    })();
  return { call, open: () => open, started: () => started };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/** A response streaming `count` chunks of `size` bytes. */
function chunked(count: number, size: number, init?: ResponseInit): Response {
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
    init,
  );
}

/** An endless response, noting whether it was cancelled. */
function endless(state: { cancelled: boolean }): Response {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(bytes(1024));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
}

/** A response that sends one chunk of 8 bytes, then nothing, for good. */
function quiet(): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (sent) return await new Promise<void>(() => {});
          sent = true;
          controller.enqueue(bytes(8));
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
  /** What the caller does with the response; may throw (asserted by `rejects`). */
  consume: (response: Response) => Promise<unknown>;
  /** The exchange is expected to fail (with a message matching this). */
  rejects?: RegExp;
}

const get = (path = "/") => new Request(`http://x${path}`);

const CASES: Case[] = [
  // Read to the end, every way a body can be read.
  {
    name: "GET, text() of a body",
    handler: async () => new Response("hello"),
    request: get,
    consume: async (r) => expect(await r.text()).toBe("hello"),
  },
  {
    name: "GET, arrayBuffer()",
    handler: async () => new Response(bytes(10)),
    request: get,
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(10),
  },
  {
    name: "GET, blob()",
    handler: async () => new Response("abc"),
    request: get,
    consume: async (r) => expect((await r.blob()).size).toBe(3),
  },
  {
    name: "GET, json()",
    handler: async () => Response.json({ a: 1 }),
    request: get,
    consume: async (r) => expect(await r.json()).toEqual({ a: 1 }),
  },
  {
    name: "GET, a reader pulled to done",
    handler: async () => chunked(5, 100),
    request: get,
    consume: async (r) => {
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      let n = 0;
      for (let c = await reader.read(); !c.done; c = await reader.read()) n += c.value.byteLength;
      expect(n).toBe(500);
    },
  },
  {
    name: "GET, for await over the body",
    handler: async () => chunked(3, 10),
    request: get,
    consume: async (r) => {
      let n = 0;
      for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) n += c.byteLength;
      expect(n).toBe(30);
    },
  },
  {
    name: "GET, an empty body",
    handler: async () => new Response(""),
    request: get,
    consume: async (r) => expect(await r.text()).toBe(""),
  },
  {
    name: "GET, a null body (status 200)",
    handler: async () => new Response(null),
    request: get,
    consume: async (r) => expect(await r.text()).toBe(""),
  },
  {
    name: "GET, a body with content-length",
    handler: async () =>
      new Response("12345", { headers: { "content-length": "5", "content-type": "text/plain" } }),
    request: get,
    consume: async (r) => expect(await r.text()).toBe("12345"),
  },
  {
    name: "GET, many small chunks",
    handler: async () => chunked(200, 3),
    request: get,
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(600),
  },
  {
    name: "GET, one large body (1 MiB)",
    handler: async () => new Response(bytes(1 << 20)),
    request: get,
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(1 << 20),
  },
  {
    name: "GET, 404 with a body",
    handler: async () => new Response("nope", { status: 404 }),
    request: get,
    consume: async (r) => expect([r.status, await r.text()]).toEqual([404, "nope"]),
  },
  {
    name: "GET, 500 returned (not thrown) with a body",
    handler: async () => new Response("broken", { status: 500 }),
    request: get,
    consume: async (r) => expect([r.status, await r.text()]).toEqual([500, "broken"]),
  },
  {
    name: "GET, a redirect",
    handler: async () => new Response(null, { status: 302, headers: { location: "/b" } }),
    request: get,
    consume: async (r) => expect(r.headers.get("location")).toBe("/b"),
  },
  // Bodyless responses: nobody reads, nothing to read.
  {
    name: "HEAD",
    handler: async () => new Response("ignored"),
    request: () => new Request("http://x/", { method: "HEAD" }),
    consume: async (r) => expect(r.body).toBeNull(),
  },
  {
    name: "OPTIONS",
    handler: async () => new Response("ignored", { headers: { allow: "GET" } }),
    request: () => new Request("http://x/", { method: "OPTIONS" }),
    consume: async (r) => expect(r.headers.get("allow")).toBe("GET"),
  },
  {
    name: "204",
    handler: async () => new Response(null, { status: 204 }),
    request: get,
    consume: async (r) => expect([r.status, r.body]).toEqual([204, null]),
  },
  {
    name: "304",
    handler: async () => new Response(null, { status: 304 }),
    request: get,
    consume: async (r) => expect(r.status).toBe(304),
  },
  {
    name: "205",
    handler: async () => new Response(null, { status: 205 }),
    request: get,
    consume: async (r) => expect(r.status).toBe(205),
  },
  // Request bodies, read or not.
  {
    name: "POST, the handler reads the body",
    handler: async (q) => new Response(`got ${await q.text()}`),
    request: () => new Request("http://x/", { method: "POST", body: "payload" }),
    consume: async (r) => expect(await r.text()).toBe("got payload"),
  },
  {
    name: "POST, the handler ignores the body",
    handler: async () => new Response("ok"),
    request: () => new Request("http://x/", { method: "POST", body: "payload" }),
    consume: async (r) => expect(await r.text()).toBe("ok"),
  },
  {
    name: "POST, an empty body",
    handler: async (q) => new Response(`[${await q.text()}]`),
    request: () => new Request("http://x/", { method: "POST", body: "" }),
    consume: async (r) => expect(await r.text()).toBe("[]"),
  },
  {
    name: "POST, the handler reads part of a large body",
    handler: async (q) => {
      const reader = (q.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.cancel();
      return new Response("enough");
    },
    request: () => new Request("http://x/", { method: "POST", body: bytes(256 * 1024) }),
    consume: async (r) => expect(await r.text()).toBe("enough"),
  },
  {
    name: "PUT, a streamed request body, echoed",
    handler: async (q) => new Response(q.body),
    request: () => {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 4) c.close();
          else c.enqueue(bytes(8));
        },
      });
      return new Request("http://x/", { method: "PUT", body, duplex: "half" } as RequestInit);
    },
    consume: async (r) => expect((await r.arrayBuffer()).byteLength).toBe(32),
  },
  {
    name: "DELETE, 204",
    handler: async () => new Response(null, { status: 204 }),
    request: () => new Request("http://x/", { method: "DELETE" }),
    consume: async (r) => expect(r.status).toBe(204),
  },
  // Left early.
  {
    name: "the body cancelled before any read",
    handler: async () => chunked(10, 10),
    request: get,
    consume: async (r) => r.body?.cancel(),
  },
  {
    name: "the body cancelled after one chunk",
    handler: async () => endless({ cancelled: false }),
    request: get,
    consume: async (r) => {
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.cancel();
    },
  },
  {
    name: "a reader released after one chunk, then the stream cancelled",
    handler: async () => endless({ cancelled: false }),
    request: get,
    consume: async (r) => {
      const body = r.body as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      await reader.read();
      reader.releaseLock();
      await body.cancel();
    },
  },
  {
    name: "break out of for await",
    handler: async () => endless({ cancelled: false }),
    request: get,
    consume: async (r) => {
      for await (const _ of r.body as unknown as AsyncIterable<Uint8Array>) break;
    },
  },
  // Failures.
  {
    name: "the handler throws (peer error)",
    handler: async () => {
      throw new Error("handler blew up");
    },
    request: get,
    consume: async () => {},
    rejects: /handler blew up/,
  },
  {
    name: "the handler throws after reading the request body",
    handler: async (q) => {
      await q.text();
      throw new Error("after the body");
    },
    request: () => new Request("http://x/", { method: "POST", body: "x" }),
    consume: async () => {},
    rejects: /after the body/,
  },
  {
    name: "the response body fails mid-stream",
    handler: async () => {
      let n = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ === 2) c.error(new Error("producer failed"));
            else c.enqueue(bytes(4));
          },
        }),
      );
    },
    request: get,
    consume: async (r) => r.text(),
    rejects: /./,
  },
];

describe("every exchange ends its call", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const t = tracked(serveFetchOverDuplex(c.handler));
      for (let i = 0; i < 25; i++) {
        const run = async () => c.consume(await fetchOverDuplex(t.call, c.request()));
        if (c.rejects) await expect(run()).rejects.toThrow(c.rejects);
        else await run();
        await settle();
        expect(t.open(), `calls left open after exchange ${i + 1}`).toBe(0);
      }
      expect(t.started()).toBe(25);
    });
  }

  it("concurrent exchanges, all read to the end", async () => {
    const t = tracked(serveFetchOverDuplex(async (q) => new Response(new URL(q.url).pathname)));
    const texts = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        fetchOverDuplex(t.call, get(`/r${i}`)).then((r) => r.text()),
      ),
    );
    expect(texts[49]).toBe("/r49");
    await settle();
    expect(t.open()).toBe(0);
  });

  it("an abort before sending opens no call at all", async () => {
    const t = tracked(serveFetchOverDuplex(async () => new Response("x")));
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchOverDuplex(t.call, new Request("http://x/", { signal: controller.signal })),
    ).rejects.toThrow();
    await settle();
    expect([t.started(), t.open()]).toEqual([0, 0]);
  });

  it("an abort while the head is awaited rejects at once, and the call ends once answered", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const t = tracked(
      serveFetchOverDuplex(async () => {
        await answered;
        return new Response("late");
      }),
    );
    const controller = new AbortController();
    const pending = fetchOverDuplex(
      t.call,
      new Request("http://x/", { signal: controller.signal }),
    );
    await settle();
    const t0 = Date.now();
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
    expect(Date.now() - t0).toBeLessThan(100);
    answer();
    await settle();
    expect(t.open()).toBe(0);
  });

  it("the request aborted mid-body ends the call and the producer", async () => {
    const state = { cancelled: false };
    const t = tracked(serveFetchOverDuplex(async () => endless(state)));
    const controller = new AbortController();
    const response = await fetchOverDuplex(
      t.call,
      new Request("http://x/", { signal: controller.signal }),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await settle();
    expect([t.open(), state.cancelled]).toEqual([0, true]);
  });

  it("an abort while the body waits for a quiet peer rejects the read at once", async () => {
    const t = tracked(serveFetchOverDuplex(async () => quiet()));
    const controller = new AbortController();
    const response = await fetchOverDuplex(
      t.call,
      new Request("http://x/", { signal: controller.signal }),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).value?.byteLength).toBe(8);
    const pending = reader.read();
    await sleep(10);
    const t0 = Date.now();
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("gave up");
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("an abort while nobody reads the body errors it with the abort's reason", async () => {
    const state = { cancelled: false };
    const t = tracked(serveFetchOverDuplex(async () => endless(state)));
    const controller = new AbortController();
    const response = await fetchOverDuplex(
      t.call,
      new Request("http://x/", { signal: controller.signal }),
    );
    await settle();
    controller.abort(new Error("gave up"));
    await settle();
    // Released at the abort, not at the next read: the producer is cancelled already.
    expect([t.open(), state.cancelled]).toEqual([0, true]);
    await expect(response.text()).rejects.toThrow("gave up");
  });

  it("a signal reused across calls keeps no listener once each body is read", async () => {
    const t = tracked(serveFetchOverDuplex(async () => new Response("hello")));
    // Spied on the request's own signal: `new Request(url, { signal })` follows
    // the given one with a listener of its own, which is not ours to count.
    const req = new Request("http://x/", { signal: new AbortController().signal });
    const signal = req.signal;
    let listening = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      listening++;
      add(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      listening--;
      remove(...args);
    }) as AbortSignal["removeEventListener"];
    for (let i = 0; i < 10; i++) {
      const r = await fetchOverDuplex(t.call, req);
      expect(await r.text()).toBe("hello");
    }
    await settle();
    expect([listening, t.open()]).toEqual([0, 0]);
  });

  it("a response that cannot be decoded ends the call", async () => {
    const t = tracked(async function* () {
      yield new TextEncoder().encode("this is not HTTP at all\r\n\r\n");
      await sleep(5);
      yield new TextEncoder().encode("more garbage");
    });
    await expect(fetchOverDuplex(t.call, get())).rejects.toThrow();
    await settle();
    expect(t.open()).toBe(0);
  });

  it("a call that ends before any response ends the exchange with an error", async () => {
    const t = tracked(async function* () {});
    await expect(fetchOverDuplex(t.call, get())).rejects.toThrow();
    await settle();
    expect(t.open()).toBe(0);
  });
  it("a handler that answers first and reads the upload afterwards gets all of it", async () => {
    const received: number[] = [];
    let stored!: () => void;
    const done = new Promise<void>((r) => (stored = r));
    const t = tracked(
      serveFetchOverDuplex(async (q) => {
        void q.arrayBuffer().then((b) => {
          received.push(b.byteLength);
          stored();
        });
        return new Response("accepted", { status: 202 });
      }),
    );
    for (let i = 0; i < 10; i++) {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await sleep(2);
          if (n++ === 5) c.close();
          else c.enqueue(bytes(10));
        },
      });
      const r = await fetchOverDuplex(
        t.call,
        new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit),
      );
      expect([r.status, await r.text()]).toEqual([202, "accepted"]);
    }
    await done;
    for (let i = 0; i < 50 && received.length < 10; i++) await sleep(5);
    await settle();
    expect(received).toEqual(Array(10).fill(50));
    expect(t.open()).toBe(0);
  });

  it("a response delivered in full never calls the handler's release", async () => {
    let releases = 0;
    const serve = (framing: "length" | "chunked") =>
      httpServe(async () => ({
        envelope: {
          status: 200,
          headers: framing === "length" ? [["content-length", "6"]] : [],
        },
        body: (async function* () {
          yield new TextEncoder().encode("abc");
          yield new TextEncoder().encode("def");
        })(),
        release: () => {
          releases++;
        },
      }));
    for (const framing of ["length", "chunked"] as const) {
      const t = tracked(serve(framing));
      const { body } = await httpFetch(t.call, { url: "http://x/", method: "GET", headers: [] });
      let text = "";
      for await (const c of body) text += new TextDecoder().decode(c);
      expect(text).toBe("abcdef");
      await settle();
      expect(t.open()).toBe(0);
    }
    expect(releases).toBe(0);
  });
  it("a handler that took the request body and dropped it: the call ends after requestIdleMs", async () => {
    let failed: unknown;
    const t = tracked(
      serveFetchOverDuplex(
        async (q) => {
          const reader = (q.body as ReadableStream<Uint8Array>).getReader();
          await reader.read();
          // Dropped without cancelling; a later read fails once abandoned.
          setTimeout(async () => {
            try {
              while (!(await reader.read()).done);
            } catch (e) {
              failed = e;
            }
          }, 200);
          return new Response("ok");
        },
        { requestIdleMs: 50 },
      ),
    );
    for (let i = 0; i < 5; i++) {
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (n++ === 5) c.close();
          else c.enqueue(bytes(10));
        },
      });
      const r = await fetchOverDuplex(
        t.call,
        new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit),
      );
      expect(await r.text()).toBe("ok");
    }
    for (let k = 0; k < 100 && t.open() > 0; k++) await sleep(10);
    expect(t.open()).toBe(0);
    await sleep(250);
    expect(String(failed)).toMatch(/left unread/);
  });
});
