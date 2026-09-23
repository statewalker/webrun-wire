import { describe, expect, it } from "vitest";
import { newPubSub } from "./handler.js";

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
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
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
