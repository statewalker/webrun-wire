import { afterEach, describe, expect, it } from "vitest";
import {
  createWebSocketClass,
  DEFAULT_HEARTBEAT_MS,
  isWebSocketUpgrade,
  newWebSocketUpgradeRequest,
  type PortWebSocket,
  requestedProtocols,
  type ServerWebSocket,
  ServerWebSocket as ServerWebSocketClass,
  serveWebSocketUpgrade,
  takePort,
  upgradeWebSocket,
  type WebSocketConnector,
  webSocketUpgradeResponse,
} from "../src/ws/index.js";

type Handler = (request: Request) => Response | Promise<Response>;

const servers: ServerWebSocket[] = [];
afterEach(() => {
  for (const socket of servers.splice(0)) {
    try {
      socket.close();
    } catch {}
  }
});

/** A connector that runs the upgrade through `handler` in this thread. */
function connector(handler: Handler): WebSocketConnector {
  return async (url, protocols) => {
    const result = await serveWebSocketUpgrade(handler, { url, protocols });
    if (!result.ok) throw new Error(result.message);
    return { port: result.port, protocol: result.protocol };
  };
}

/** An echo server; answers the first requested protocol unless `protocol` says otherwise. */
function echo(options: { protocol?: string; accept?: boolean } = {}): Handler {
  return (request) => {
    if (!isWebSocketUpgrade(request)) return new Response("not a socket", { status: 426 });
    const protocol = options.protocol ?? requestedProtocols(request)[0] ?? "";
    const { socket, response } = upgradeWebSocket(request, { protocol });
    servers.push(socket);
    if (options.accept !== false) socket.accept();
    socket.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (data === "close-me") socket.close(4001, "asked");
      else socket.send(data);
    });
    return response;
  };
}

function next<T extends Event = Event>(target: EventTarget, type: string): Promise<T> {
  return new Promise((resolve) =>
    target.addEventListener(type, (e) => resolve(e as T), { once: true }),
  );
}

const URL_ = "ws://example.test/chat";

describe("createWebSocketClass: validation", () => {
  const WS = createWebSocketClass(connector(echo()));

  it("rejects a bad url, a bad scheme and a fragment", () => {
    expect(() => new WS("not a url")).toThrow(/invalid/);
    expect(() => new WS("ftp://example.test/")).toThrow(/scheme/);
    expect(() => new WS("ws://example.test/#x")).toThrow(/fragment/);
  });

  it("maps http to ws and https to wss", () => {
    expect(new WS("http://example.test/a").url).toBe("ws://example.test/a");
    expect(new WS("https://example.test/a").url).toBe("wss://example.test/a");
  });

  it("rejects invalid and duplicated subprotocols", () => {
    expect(() => new WS(URL_, ["a b"])).toThrow(/invalid/);
    expect(() => new WS(URL_, ["a", "a"])).toThrow(/duplicated/);
  });

  it("checks close codes and reasons", async () => {
    const ws = new WS(URL_);
    await next(ws, "open");
    expect(() => ws.close(1001)).toThrow(/close code/);
    expect(() => ws.close(1000, "x".repeat(124))).toThrow(/123 bytes/);
    ws.close();
  });

  it("refuses send while connecting", () => {
    const ws = new WS(URL_);
    expect(() => ws.send("x")).toThrow(/CONNECTING/);
  });
});

describe("createWebSocketClass: messages", () => {
  it("opens, echoes text and binary, and negotiates a subprotocol", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_, ["v1", "v2"]);
    expect(ws.readyState).toBe(WS.CONNECTING);
    await next(ws, "open");
    expect(ws.readyState).toBe(WS.OPEN);
    expect(ws.protocol).toBe("v1");

    ws.send("hello");
    expect((await next<MessageEvent>(ws, "message")).data).toBe("hello");

    ws.binaryType = "arraybuffer";
    const bytes = new Uint8Array([1, 2, 3]);
    ws.send(bytes);
    const reply = (await next<MessageEvent>(ws, "message")).data as ArrayBuffer;
    expect(new Uint8Array(reply)).toEqual(bytes);
    // The caller's buffer is copied, never detached.
    expect(bytes.byteLength).toBe(3);

    ws.binaryType = "blob";
    ws.send(new Blob([new Uint8Array([9])]));
    const blob = (await next<MessageEvent>(ws, "message")).data as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([9]));
    ws.close();
  });

  it("calls the on* handlers", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    const seen: string[] = [];
    ws.onopen = () => {
      seen.push("open");
      ws.send("x");
    };
    ws.onmessage = (event) => {
      seen.push(`message:${event.data}`);
      ws.close(1000, "done");
    };
    const closed = new Promise<CloseEvent>((resolve) => {
      ws.onclose = resolve;
    });
    const event = await closed;
    expect(seen).toEqual(["open", "message:x"]);
    expect(event).toMatchObject({ code: 1000, reason: "done", wasClean: true });
  });

  it("keeps the order of 10 000 messages, mixing text, binary and blobs", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    ws.binaryType = "arraybuffer";
    await next(ws, "open");
    const received: string[] = [];
    const done = new Promise<void>((resolve) => {
      ws.addEventListener("message", (event) => {
        const data = (event as MessageEvent).data;
        received.push(typeof data === "string" ? data : `${new Uint8Array(data)[0]}`);
        if (received.length === 10_000) resolve();
      });
    });
    const expected: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const kind = i % 3;
      if (kind === 0) ws.send(`${i % 256}`);
      else if (kind === 1) ws.send(new Uint8Array([i % 256]));
      else ws.send(new Blob([new Uint8Array([i % 256])]));
      expected.push(`${i % 256}`);
    }
    await done;
    expect(received).toEqual(expected);
    ws.close();
  });

  it("bufferedAmount counts what the server has not consumed, and falls as it reads", async () => {
    const WS = createWebSocketClass(connector(echo({ accept: false })));
    const ws = new WS(URL_);
    await next(ws, "open");
    ws.send("12345");
    ws.send(new Uint8Array(10));
    expect(ws.bufferedAmount).toBe(15);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not accepted: nothing consumed yet.
    expect(ws.bufferedAmount).toBe(15);
    servers[0]?.accept();
    await ws.whenDrained();
    expect(ws.bufferedAmount).toBe(0);
    ws.close();
  });
});

describe("createWebSocketClass: closing", () => {
  it("a refused upgrade gives error, then close with 1006", async () => {
    const WS = createWebSocketClass(connector(() => new Response(null, { status: 404 })));
    const ws = new WS(URL_);
    const events: string[] = [];
    ws.addEventListener("error", () => events.push("error"));
    const close = await next<CloseEvent>(ws, "close");
    expect(events).toEqual(["error"]);
    expect(close).toMatchObject({ code: 1006, wasClean: false });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  it("a connection that is not one (an older peer answered `true`) fails, not hangs", async () => {
    const WS = createWebSocketClass(async () => true as never);
    const ws = new WS(URL_);
    const events: string[] = [];
    ws.addEventListener("error", () => events.push("error"));
    expect((await next<CloseEvent>(ws, "close")).code).toBe(1006);
    expect(events).toEqual(["error"]);
  });

  it("an unrequested subprotocol is a failure", async () => {
    const WS = createWebSocketClass(connector(echo({ protocol: "other" })));
    const ws = new WS(URL_, ["v1"]);
    expect((await next<CloseEvent>(ws, "close")).code).toBe(1006);
  });

  it("the server closes: the client echoes, both clean", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    await next(ws, "open");
    const serverClosed = next<CloseEvent>(servers[0] as EventTarget, "close");
    ws.send("close-me");
    const close = await next<CloseEvent>(ws, "close");
    expect(close).toMatchObject({ code: 4001, reason: "asked", wasClean: true });
    expect(await serverClosed).toMatchObject({ code: 4001, wasClean: true });
  });

  it("the client closes: the server sees the code", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    await next(ws, "open");
    const serverClosed = next<CloseEvent>(servers[0] as EventTarget, "close");
    ws.close(3001, "bye");
    expect(ws.readyState).toBe(ws.CLOSING);
    expect(await serverClosed).toMatchObject({ code: 3001, reason: "bye", wasClean: true });
    expect(await next<CloseEvent>(ws, "close")).toMatchObject({ code: 3001, wasClean: true });
  });

  it("close() while connecting fails the connection", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    ws.close();
    const close = await next<CloseEvent>(ws, "close");
    expect(close).toMatchObject({ code: 1006, wasClean: false });
  });

  it("send after close counts in bufferedAmount and is dropped", async () => {
    const WS = createWebSocketClass(connector(echo()));
    const ws = new WS(URL_);
    await next(ws, "open");
    ws.close();
    ws.send("abc");
    expect(ws.bufferedAmount).toBe(3);
  });
});

describe("heartbeat", () => {
  it("the client closes with 1006 when the server stops answering", async () => {
    let serverPort: MessagePort | undefined;
    const WS = createWebSocketClass(
      async () => {
        const channel = new MessageChannel();
        serverPort = channel.port1; // never answers pings
        serverPort.start();
        return { port: channel.port2, protocol: "" };
      },
      { heartbeatMs: 30 },
    );
    const ws: PortWebSocket = new WS(URL_);
    await next(ws, "open");
    const close = await next<CloseEvent>(ws, "close");
    expect(close).toMatchObject({ code: 1006, wasClean: false });
    serverPort?.close();
  });

  it("the server closes with 1006 when pings stop", async () => {
    const request = new Request("http://example.test/x");
    const { socket, response } = upgradeWebSocket(request);
    socket.accept();
    // A client that pings once, with a short period, then dies.
    const port = (await import("../src/ws/upgrade.js")).takePort(response);
    port?.postMessage({ t: "p", hb: 20 });
    const close = await next<CloseEvent>(socket, "close");
    expect(close).toMatchObject({ code: 1006, wasClean: false });
  });
});

describe("heartbeat watch from the first ping", () => {
  const port = async (response: Response) =>
    (await import("../src/ws/upgrade.js")).takePort(response) as MessagePort;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Timers that count the watches armed and still armed. */
  function counted() {
    let armed = 0;
    const timers = {
      setInterval: (fn: () => void, ms: number) => {
        armed++;
        return setInterval(fn, ms);
      },
      clearInterval: (id: unknown) => {
        armed--;
        clearInterval(id as ReturnType<typeof setInterval>);
      },
    };
    return { timers, armed: () => armed };
  }

  it("no watch until the peer pings; the default watches from open", async () => {
    const def = counted();
    const late = counted();
    const watched = upgradeWebSocket(new Request("http://example.test/x"), { timers: def.timers });
    const unwatched = upgradeWebSocket(new Request("http://example.test/x"), {
      timers: late.timers,
      watch: "first-ping",
    });
    servers.push(watched.socket, unwatched.socket);
    expect([def.armed(), late.armed()]).toEqual([1, 0]);
    const client = await port(unwatched.response);
    await sleep(50);
    expect([unwatched.socket.readyState, late.armed()]).toEqual([1, 0]);
    // The first ping with the default period, as the package's client sends it: the period does
    // not change, and still the first ping arms the watch.
    client.postMessage({ t: "p", hb: DEFAULT_HEARTBEAT_MS });
    await sleep(20);
    expect(late.armed()).toBe(1);
    client.postMessage({ t: "p", hb: DEFAULT_HEARTBEAT_MS });
    await sleep(20);
    expect(late.armed()).toBe(1); // the same period again: still one watch
  });

  it("once the peer pings, its pings stopping closes the socket with 1006", async () => {
    const { socket, response } = upgradeWebSocket(new Request("http://example.test/x"), {
      watch: "first-ping",
    });
    socket.accept();
    const client = await port(response);
    // A first ping long after the socket opened (over three of its periods): the watch counts
    // from the ping, so the socket is still open a period later.
    // (hb 50: the earliest close is the tick ~200 ms after the ping, so the check at 60 ms has
    // ~140 ms of slack on a loaded runner.)
    await sleep(200);
    client.postMessage({ t: "p", hb: 50 });
    await sleep(60);
    expect(socket.readyState).toBe(1);
    // Then silence.
    const close = await next<CloseEvent>(socket, "close");
    expect(close).toMatchObject({ code: 1006, wasClean: false });
  });
});

describe("server end: other platforms' semantics (workerd's WebSocketPair)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** A server end and the raw port of its client, which posts and reads frames. */
  function end(options: Parameters<typeof upgradeWebSocket>[1] = {}) {
    const { socket, response } = upgradeWebSocket(new Request("http://example.test/x"), options);
    servers.push(socket);
    const client = takePort(response) as MessagePort;
    const frames: Array<{ t: string; [k: string]: unknown }> = [];
    client.onmessage = (e) => frames.push(e.data);
    return { socket, client, frames };
  }

  it("sendBeforeAccept: send() works before accept(); by default it throws", async () => {
    const strict = end();
    expect(() => strict.socket.send("x")).toThrow(/accept/);
    const loose = end({ sendBeforeAccept: true });
    loose.socket.send("early");
    await sleep(10);
    expect(loose.frames).toContainEqual({ t: "m", d: "early" });
  });

  it("defaultCloseCode: close() with no code sends it (1005); the default stays 1000", async () => {
    const workerd = end({ defaultCloseCode: 1005 });
    workerd.socket.close();
    const plain = end();
    plain.socket.close();
    await sleep(10);
    expect(workerd.frames).toContainEqual({ t: "c", code: 1005, reason: "" });
    expect(plain.frames).toContainEqual({ t: "c", code: 1000, reason: "" });
  });

  it("closeTimeoutMs Infinity: close() waits for the echo however long", async () => {
    const { socket } = end({ closeTimeoutMs: Infinity });
    socket.close(1000);
    await sleep(50); // a timer given Infinity would have fired at once
    expect(socket.readyState).toBe(2);
  });

  it('heartbeatPeriod "first": a later, longer period does not stretch the watch', async () => {
    const first = end({ heartbeatPeriod: "first" });
    const follow = end();
    for (const { client } of [first, follow]) {
      client.postMessage({ t: "p", hb: 20 });
      client.postMessage({ t: "p", hb: 60_000 }); // the page turned hidden, then went silent
    }
    const close = await next<CloseEvent>(first.socket, "close");
    expect(close.code).toBe(1006);
    expect(follow.socket.readyState).toBe(1);
  });

  it("a ping announcing a period past what a timer takes (no heartbeat) arms no watch", async () => {
    let armed = 0;
    const timers = {
      setInterval: (fn: () => void, ms: number) => {
        armed++;
        return setInterval(fn, ms);
      },
      clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
    };
    const { client, socket } = end({ watch: "first-ping", timers });
    // A client with `heartbeatMs: 0` announces 2^31 - 1 (a frame's 0 reads as the default).
    client.postMessage({ t: "p", hb: 2 ** 31 - 1 });
    client.postMessage({ t: "p", hb: 2 ** 40 });
    await sleep(20);
    expect([armed, socket.readyState]).toEqual([0, 1]);
  });

  it('binaryType "blob": binary messages arrive as Blobs', async () => {
    const { socket, client } = end();
    socket.binaryType = "blob";
    socket.binaryType = "nonsense" as "blob"; // ignored, as in browsers
    socket.accept();
    const got = next<MessageEvent>(socket, "message");
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    client.postMessage({ t: "m", d: bytes }, [bytes]);
    const data = (await got).data;
    expect(data).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (data as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("checkClose: a subclass applies its platform's close rules", () => {
    class Strict extends ServerWebSocketClass {
      protected override checkClose(code: number | undefined, reason: string): void {
        if (code === 1001) throw new TypeError("1001 is not for Worker code");
        super.checkClose(code, reason);
      }
    }
    const { port1, port2 } = new MessageChannel();
    const socket = new Strict(port1);
    expect(() => socket.close(1001)).toThrow(/Worker code/);
    socket.close(1000);
    port1.close();
    port2.close();
  });

  it("detach: the frames that reached the unaccepted end come first, then the rest, both ways", async () => {
    const { socket, client } = end();
    client.postMessage({ t: "m", d: "before" });
    await sleep(10); // queued at the unaccepted end
    const port = socket.detach();
    expect(socket.readyState).toBe(3);
    const atNewHolder: unknown[] = [];
    port.onmessage = (e) => atNewHolder.push(e.data);
    client.postMessage({ t: "m", d: "after" });
    const fromHolder = new Promise((r) => (client.onmessage = (e) => r(e.data)));
    port.postMessage({ t: "m", d: "reply" });
    expect(await fromHolder).toEqual({ t: "m", d: "reply" });
    await sleep(10);
    expect(atNewHolder).toEqual([
      { t: "m", d: "before" },
      { t: "m", d: "after" },
    ]);
    const accepted = end();
    accepted.socket.accept();
    expect(() => accepted.socket.detach()).toThrow(/detached/);
  });
});

describe("server end", () => {
  it("queues frames until accept(), and refuses send before it", async () => {
    const WS = createWebSocketClass(connector(echo({ accept: false })));
    const ws = new WS(URL_);
    await next(ws, "open");
    ws.send("early");
    const server = servers[0] as ServerWebSocket;
    expect(() => server.send("x")).toThrow(/accept/);
    const got: string[] = [];
    server.addEventListener("message", (event) => got.push((event as MessageEvent).data));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(got).toEqual([]);
    server.accept();
    expect(got).toEqual(["early"]);
    ws.close();
  });

  it("whenDrained waits for the client to consume", async () => {
    let server!: ServerWebSocket;
    const WS = createWebSocketClass(
      connector((request) => {
        const upgrade = upgradeWebSocket(request);
        server = upgrade.socket;
        server.accept();
        return upgrade.response;
      }),
    );
    const ws = new WS(URL_);
    await next(ws, "open");
    let received = 0;
    ws.addEventListener("message", () => received++);
    for (let i = 0; i < 100; i++) server.send(new Uint8Array(1024));
    expect(server.bufferedAmount).toBe(100 * 1024);
    await server.whenDrained();
    expect(server.bufferedAmount).toBe(0);
    expect(received).toBe(100);
    ws.close();
  });

  it("webSocketUpgradeResponse: a 101 over a port the handler serves itself", async () => {
    const channel = new MessageChannel();
    const result = await serveWebSocketUpgrade(
      () => webSocketUpgradeResponse(channel.port2, "v2"),
      { url: "ws://example.test/x", protocols: ["v1", "v2"] },
    );
    expect(result).toMatchObject({ ok: true, protocol: "v2" });
    if (!result.ok) return;
    // The caller's port is the one the handler gave: a frame crosses to the handler's end.
    const got = new Promise((r) => (channel.port1.onmessage = (e) => r(e.data)));
    result.port.postMessage({ t: "m", d: "hi" });
    expect(await got).toEqual({ t: "m", d: "hi" });
    channel.port1.close();
    result.port.close();
  });

  it("the subprotocols asked for come from `protocols`, not from a caller's header", () => {
    const none = newWebSocketUpgradeRequest("ws://example.test/x", {
      headers: { "sec-websocket-protocol": "v1", "x-shard": "7" },
    });
    expect([requestedProtocols(none), none.headers.get("x-shard")]).toEqual([[], "7"]);
    const two = newWebSocketUpgradeRequest("ws://example.test/x", {
      protocols: ["v2", "v3"],
      headers: { "sec-websocket-protocol": "v1" },
    });
    expect(requestedProtocols(two)).toEqual(["v2", "v3"]);
  });

  it("the upgrade request carries its forbidden headers", async () => {
    let seen: Request | undefined;
    await serveWebSocketUpgrade(
      (request) => {
        seen = request;
        return new Response(null, { status: 403 });
      },
      { url: "wss://example.test/x", protocols: ["a", "b"] },
    );
    expect(seen?.url).toBe("https://example.test/x");
    expect(seen && isWebSocketUpgrade(seen)).toBe(true);
    expect(seen && requestedProtocols(seen)).toEqual(["a", "b"]);
    expect(seen?.headers.get("sec-websocket-version")).toBe("13");
  });
});
