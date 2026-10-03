import { describe, expect, it, vi } from "vitest";
import { newBroker } from "./broker.js";
import { createSseSource, newPubSub } from "./handler.js";

/** Read exactly `count` SSE frames off a response body, then release it. */
async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let i = buffer.indexOf("\n\n"); i !== -1; i = buffer.indexOf("\n\n")) {
      frames.push(buffer.slice(0, i + 2));
      buffer = buffer.slice(i + 2);
    }
  }
  await reader.cancel();
  return frames;
}

describe("newPubSub handler", () => {
  it("answers with an event-stream content type", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/build"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    await res.body?.cancel();
  });

  it("streams events published after the subscription opens", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/build"));
    const frames = readFrames(res, 2);
    ps.publish("build", { changed: ["/a.html"] }, "rebuilt");
    ps.publish("build", { changed: ["/b.html"] }, "rebuilt");
    expect(await frames).toEqual([
      'id: 1\nevent: rebuilt\ndata: {"changed":["/a.html"]}\n\n',
      'id: 2\nevent: rebuilt\ndata: {"changed":["/b.html"]}\n\n',
    ]);
  });

  it("replays missed events when Last-Event-ID is supplied", async () => {
    const ps = newPubSub();
    ps.publish("build", "one");
    ps.publish("build", "two");
    const res = await ps.handler(
      new Request("http://h/_events/build", { headers: { "last-event-id": "1" } }),
    );
    const frames = await readFrames(res, 1);
    expect(frames[0]).toBe('id: 2\ndata: "two"\n\n');
  });

  // (4) a gap the buffer cannot cover must be signalled, not silently partial
  it("signals a gap when Last-Event-ID predates the replay buffer", async () => {
    const ps = newPubSub({ bufferSize: 2 });
    for (const d of ["a", "b", "c", "d"]) ps.publish("build", d);
    const res = await ps.handler(
      new Request("http://h/_events/build", { headers: { "last-event-id": "1" } }),
    );
    const frames = await readFrames(res, 1);
    expect(frames[0]).toContain("event: gap");
  });

  it("releases the subscriber when the client cancels the body", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/build"));
    await readFrames(res, 0); // opens and cancels the reader
    expect(ps.subscriberCount("build")).toBe(0);
  });
});

describe("newPubSub handler — hostile input", () => {
  // C-1: `publish("build", undefined, "reload")` — a payload-free signal — used to
  // throw out of publish(), and then out of ps.handler() for every reconnecting
  // client that hit the event in the replay ring.
  it("survives a payload that cannot be serialized, live and on replay", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/build"));
    const frames = readFrames(res, 1);

    expect(() => ps.publish("build", undefined, "reload")).not.toThrow();
    expect(await frames).toEqual(["id: 1\nevent: reload\ndata: null\n\n"]);

    const again = await ps.handler(
      new Request("http://h/_events/build", { headers: { "last-event-id": "0" } }),
    );
    expect((await readFrames(again, 1))[0]).toBe("id: 1\nevent: reload\ndata: null\n\n");
  });

  // C-2, through the handler: a Last-Event-ID from a previous server epoch.
  it("signals a gap when Last-Event-ID is above anything this server has issued", async () => {
    const ps = newPubSub();
    ps.publish("build", "a");
    const res = await ps.handler(
      new Request("http://h/_events/build", { headers: { "last-event-id": "42" } }),
    );
    expect((await readFrames(res, 1))[0]).toContain("event: gap");
  });

  // m-12: an unparseable id used to skip the replay block entirely — no replay and
  // no gap, so a client whose id was mangled was told nothing at all.
  it("signals a gap when Last-Event-ID cannot be parsed", async () => {
    const ps = newPubSub();
    ps.publish("build", "a");
    const res = await ps.handler(
      new Request("http://h/_events/build", { headers: { "last-event-id": "abc" } }),
    );
    expect((await readFrames(res, 1))[0]).toContain("event: gap");
  });

  it("rejects a non-GET request", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/build", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(ps.topicCount()).toBe(0);
  });

  it("rejects a request with no topic", async () => {
    const ps = newPubSub();
    expect((await ps.handler(new Request("http://h/"))).status).toBe(404);
    expect(ps.topicCount()).toBe(0);
  });

  it("serves only the allow-listed topics when one is configured", async () => {
    const ps = newPubSub({ topics: ["build"] });
    expect((await ps.handler(new Request("http://h/_events/evil"))).status).toBe(404);
    expect(ps.topicCount()).toBe(0);
    const ok = await ps.handler(new Request("http://h/_events/build"));
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
  });

  // I-6: any GET /_events/<random> allocated a topic that was never reclaimed.
  it("drops topic state once the last subscriber leaves and nothing is retained", async () => {
    const ps = newPubSub();
    const res = await ps.handler(new Request("http://h/_events/ghost"));
    expect(ps.topicCount()).toBe(1);
    await res.body?.cancel();
    expect(ps.subscriberCount("ghost")).toBe(0);
    expect(ps.topicCount()).toBe(0);
  });
});

describe("newPubSub handler — a stream that breaks", () => {
  // m-13: `unsubscribe` was assigned only after the replay loop, so send's catch
  // called it on undefined and then subscribed anyway; the catch also never closed
  // the controller, leaving a dead stream open to swallow every later event.
  it("releases the subscriber and closes the stream when the first send fails", () => {
    const broker = newBroker();
    broker.publish("build", "a");
    const source = createSseSource(broker, "build", { replayFrom: 0 });

    let closed = false;
    const controller = {
      enqueue() {
        throw new TypeError("the client went away");
      },
      close() {
        closed = true;
      },
      error() {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    source.start?.(controller);

    expect(broker.subscriberCount("build")).toBe(0);
    expect(closed).toBe(true);
  });

  // m-14: opt-in keepalive. Comment frames are ignored by the SSE parser but keep a
  // half-open connection observable to proxies.
  it("emits comment frames when a heartbeat interval is configured", async () => {
    vi.useFakeTimers();
    try {
      const ps = newPubSub({ heartbeatMs: 1000 });
      const res = await ps.handler(new Request("http://h/_events/build"));
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      vi.advanceTimersByTime(2500);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": ping\n\n");
      await reader.cancel();
      expect(ps.subscriberCount("build")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
