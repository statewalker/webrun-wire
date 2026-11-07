import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChannelCalls } from "../src/core/data-calls.js";
import {
  connectHttpLink,
  HTTP_LINK_PROTOCOL,
  type HttpLinkOptions,
  serveHttpLink,
} from "../src/link/http-link.js";
import { answerConnect } from "../src/relay/index.js";
import { startRelayServiceWorker } from "../src/relay/index-sw.js";
import { SwHttpDispatcher } from "../src/sw/http-sw-dispatcher.js";
import { ATTACH_CALL } from "../src/sw/protocol.js";

// No IndexedDB under Node: the workers' persisted state starts empty.
vi.mock("idb-keyval", () => ({ get: async () => undefined, set: async () => {} }));

// The link's `window` option: by default the link asks every request's port
// for a 256 KiB window and pipelines its bodies; `window: 0` is the link as it
// was before the option, envelope for envelope. The ServiceWorkers' own links
// (same-origin dispatcher, relay worker) take the same option.

const KiB = 1024;

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** Bytes of `count` chunks of `size`, as a stream that yields them one by one. */
function chunks(count: number, size: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i < count) controller.enqueue(new Uint8Array(size).fill(i++));
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

type Wire = { up: unknown[]; down: unknown[] };
type Handler = (request: Request) => Promise<Response>;

/** The answering end: reads the upload, answers 3 chunks of its size. */
const handler: Handler = async (request) => {
  const body = new Uint8Array(await request.arrayBuffer());
  return new Response(chunks(3, body.byteLength), { headers: { "x-size": `${body.length}` } });
};

/**
 * How a request reaches `handler`: straight over a link, or through one of
 * the ServiceWorkers. Each records what crossed the handler's link each way:
 * `up` towards the handler, `down` back from it.
 */
type Route = (options?: HttpLinkOptions) => Promise<{
  wire: Wire;
  send(request: Request): Promise<Response>;
  close(): Promise<unknown>;
}>;

/** A `MessageChannel` whose two ends record what they receive. */
function recordedChannel() {
  const channel = new MessageChannel();
  const wire: Wire = { up: [], down: [] };
  channel.port2.addEventListener("message", (event) => wire.up.push(event.data));
  channel.port1.addEventListener("message", (event) => wire.down.push(event.data));
  closers.push(
    () => channel.port1.close(),
    () => channel.port2.close(),
  );
  return { calling: channel.port1, answering: channel.port2, wire };
}

const overLink: Route = async (options) => {
  const { calling, answering, wire } = recordedChannel();
  const stop = await serveHttpLink(answering, handler, options);
  const link = await connectHttpLink(calling, options);
  return {
    wire,
    send: (request) => link.send(request),
    close: async () => {
      await link.close();
      await stop();
    },
  };
};

/** A stand-in for a ServiceWorker's `self`, with the clients `register` adds. */
function fakeSelf() {
  const clients = new Map<string, unknown>();
  const self = Object.assign(new EventTarget(), {
    location: { href: "http://x/sw.js", origin: "http://x" },
    clients: {
      get: async (id: string) => clients.get(id),
      matchAll: async () => [...clients.values()],
      claim: async () => {},
    },
    skipWaiting: async () => {},
  }) as unknown as ServiceWorkerGlobalScope;
  return { self, clients };
}

/** Posts a channel call on `self` as a page would, and resolves with its answer. */
function channelCall(
  self: ServiceWorkerGlobalScope,
  type: string,
  params: unknown,
  ports: MessagePort[] = [],
  source = "A",
) {
  return new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
    const reply = new MessageChannel();
    reply.port1.onmessage = (event) => {
      reply.port1.close();
      resolve(event.data);
    };
    const event = new MessageEvent("message", { data: { type, params } });
    Object.defineProperty(event, "ports", { value: [reply.port2, ...ports] });
    Object.defineProperty(event, "source", { value: { id: source } });
    (self as unknown as EventTarget).dispatchEvent(event);
  });
}

/** Same-origin mode: a page's handler attached to the `SwHttpDispatcher`. */
const throughDispatcher: Route = async (options) => {
  const { calling, answering, wire } = recordedChannel();
  const stop = await serveHttpLink(answering, handler);
  const { self, clients } = fakeSelf();
  clients.set("A", { id: "A" }); // the attaching page, alive
  const dispatcher = new SwHttpDispatcher({ self, ...options });
  dispatcher.start();
  const attached = await channelCall(
    dispatcher.self,
    ATTACH_CALL,
    { wire: HTTP_LINK_PROTOCOL, key: "upload" },
    [calling],
  );
  expect(attached.error).toBeUndefined();
  return {
    wire,
    send: (request) => dispatcher.dispatch(request),
    close: async () => {
      await dispatcher.stop();
      await stop();
    },
  };
};

/**
 * Relay mode: a service registered with the relay worker, which opens a
 * link per request (`CONNECT`). The relay keeps its end of the link, so the
 * service's end records both ways.
 */
const throughRelay: Route = async (options) => {
  const { self, clients } = fakeSelf();
  const wire: Wire = { up: [], down: [] };
  const page = new MessageChannel();
  clients.set("A", page.port1);
  const stopPage = handleChannelCalls(page.port2, "CONNECT", async (_event, data, callPort) => {
    const port = callPort as MessagePort;
    port.addEventListener("message", (event) => wire.up.push(event.data));
    const post = port.postMessage.bind(port);
    port.postMessage = ((message: unknown, transfer?: Transferable[]) => {
      wire.down.push(structuredClone(message));
      post(message, transfer as Transferable[]);
    }) as typeof port.postMessage;
    return await answerConnect(handler, data, port);
  });
  const stopRelay = startRelayServiceWorker(self, {
    mounts: [{ key: "upload", path: "/upload" }],
    ...options,
  });
  expect((await channelCall(self, "REGISTER", { key: "upload" })).error).toBeUndefined();
  closers.push(
    () => page.port1.close(),
    () => page.port2.close(),
  );
  return {
    wire,
    send: (request) =>
      new Promise<Response>((resolve, reject) => {
        const event = Object.assign(new Event("fetch"), {
          request,
          respondWith: (response: Promise<Response>) => response.then(resolve, reject),
        });
        (self as unknown as EventTarget).dispatchEvent(event);
      }),
    close: async () => {
      stopRelay();
      stopPage();
    },
  };
};

/**
 * One POST with a streamed body, answered with a streamed body, by `route`.
 * Returns what crossed the handler's link each way, and what came back.
 */
async function exchange(route: Route, options?: HttpLinkOptions) {
  const { wire, send, close } = await route(options);
  const response = await send(
    new Request("http://x/upload", {
      method: "POST",
      body: chunks(3, 4),
      duplex: "half",
    } as RequestInit),
  );
  const received = new Uint8Array(await response.arrayBuffer());
  // The exchange as far as the body's end: how each route then takes its
  // link down is its own business.
  const exchanged: Wire = { up: [...wire.up], down: [...wire.down] };
  await close();
  return { wire, exchanged, received, size: response.headers.get("x-size") };
}

/** The stream ports' envelopes only (they carry an id), not the link's own messages. */
function streams(wire: Wire): Wire {
  const isEnvelope = (m: unknown) => typeof (m as { id?: unknown } | null)?.id === "number";
  return { up: wire.up.filter(isEnvelope), down: wire.down.filter(isEnvelope) };
}

/**
 * The wire with its random call ids replaced by their order of appearance,
 * so that two runs of the same exchange compare equal.
 */
function normalized(wire: Wire) {
  const ids = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (key !== "callId" || typeof v !== "string") return [key, walk(v)];
        if (!ids.has(v)) ids.set(v, `call-${ids.size}`);
        return [key, ids.get(v)];
      }),
    );
  };
  return { up: walk(wire.up), down: walk(wire.down) };
}

/** The `open` envelopes that crossed the channel from the calling end. */
function opens(wire: Pick<Wire, "up">) {
  return wire.up.filter((m) => (m as { type?: unknown }).type === "open") as Array<{
    window?: number;
    caps?: string[];
  }>;
}

/** Chunk confirmations (`response:result`) that crossed the channel either way. */
function confirmations(wire: Wire) {
  const isConfirmation = (m: unknown) =>
    (m as { payload?: { type?: unknown } }).payload?.type === "response:result";
  return wire.up.filter(isConfirmation).length + wire.down.filter(isConfirmation).length;
}

describe("HTTP link window", () => {
  it("with window: 0 puts exactly today's envelopes on the wire", async () => {
    const { wire, received, size } = await exchange(overLink, { window: 0 });
    expect(size).toBe("12");
    expect(received).toEqual(
      new Uint8Array([...Array(12).fill(0), ...Array(12).fill(1), ...Array(12).fill(2)]),
    );
    // Recorded from the link before it had a window: a change here is a
    // change of what an older peer receives.
    expect(normalized(wire)).toMatchSnapshot();
  });

  it("asks for a 256 KiB window by default and pipelines the bodies", async () => {
    const plain = await exchange(overLink, { window: 0 });
    const piped = await exchange(overLink);
    expect(piped.received).toEqual(plain.received);
    expect(
      opens(plain.wire).every((open) => open.window === undefined && open.caps === undefined),
    ).toBe(true);
    expect(opens(piped.wire).length).toBeGreaterThan(0);
    for (const open of opens(piped.wire)) {
      expect(open.window).toBe(256 * KiB);
      expect(open.caps).toContain("pipeline");
    }
    // Pipelined, a chunk needs no confirmation: at most the first chunk each
    // way goes confirmed while the handshake settles.
    expect(confirmations(piped.wire)).toBeLessThan(confirmations(plain.wire));
    expect(confirmations(piped.wire)).toBeLessThanOrEqual(2);
  });

  it("asks for the window it is given", async () => {
    const { wire } = await exchange(overLink, { window: 64 * KiB });
    for (const open of opens(wire)) expect(open.window).toBe(64 * KiB);
  });

  for (const [name, route] of [
    ["the same-origin ServiceWorker (SwHttpDispatcher)", throughDispatcher],
    ["the relay worker", throughRelay],
  ] as const) {
    it(`through ${name}, window: 0 puts the link's window: 0 envelopes on the wire`, async () => {
      const link = await exchange(overLink, { window: 0 });
      const sw = await exchange(route, { window: 0 });
      expect(sw.size).toBe("12");
      expect(sw.received).toEqual(link.received);
      expect(normalized(streams(sw.exchanged))).toEqual(normalized(streams(link.exchanged)));
    });

    it(`through ${name}, the default asks for 256 KiB and pipelines`, async () => {
      const { wire, received } = await exchange(route);
      expect(received).toHaveLength(36);
      expect(opens(wire).length).toBeGreaterThan(0);
      for (const open of opens(wire)) {
        expect(open.window).toBe(256 * KiB);
        expect(open.caps).toContain("pipeline");
      }
      expect(confirmations(wire)).toBeLessThanOrEqual(2);
    });
  }
});
