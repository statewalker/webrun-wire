import { afterEach, describe, expect, it } from "vitest";
import {
  connectHttpLink,
  type HttpLink,
  LinkLostError,
  serveHttpLink,
} from "../src/link/http-link.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function linked(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<{ link: HttpLink; stop: () => Promise<void> }> {
  const channel = new MessageChannel();
  const stop = await serveHttpLink(channel.port2, handler);
  const link = await connectHttpLink(channel.port1);
  closers.push(
    () => link.close(),
    () => stop(),
    () => channel.port1.close(),
    () => channel.port2.close(),
  );
  return { link, stop };
}

function endless() {
  const state = { produced: 0, cancelled: 0 };
  const handler = () =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.produced++;
            controller.enqueue(new Uint8Array(65536));
          },
          cancel() {
            state.cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  return { state, handler };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HTTP links", () => {
  it("round-trips a request with a body", async () => {
    const { link } = await linked(async (request) => {
      const text = await request.text();
      return new Response(`${request.method} ${new URL(request.url).pathname} ${text}`, {
        status: 201,
        headers: { "x-a": "b" },
      });
    });
    const response = await link.send(
      new Request("http://x/path", { method: "POST", body: "hello" }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-a")).toBe("b");
    expect(await response.text()).toBe("POST /path hello");
    expect(link.inflight).toBe(0);
  });

  it("backpressure: the producer stays a few chunks ahead of a slow reader", async () => {
    const { state, handler } = endless();
    const { link } = await linked(handler);
    const response = await link.send(new Request("http://x/"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (let i = 0; i < 30; i++) {
      await reader.read();
      await tick(2);
    }
    expect(state.produced - 30).toBeLessThanOrEqual(4);
    expect(link.inflight).toBe(1);
    await reader.cancel();
    await tick(20);
    expect(state.cancelled).toBe(1);
    expect(link.inflight).toBe(0);
  });

  it("counts a streaming response in flight until it ends", async () => {
    const { link } = await linked(() => new Response("abc"));
    const response = await link.send(new Request("http://x/"));
    expect(link.inflight).toBe(1);
    const idle = link.whenIdle();
    await response.text();
    await idle;
    expect(link.inflight).toBe(0);
  });

  it("closing the link fails requests in flight, head or body", async () => {
    let release: () => void = () => {};
    const { link } = await linked(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response("late"));
        }),
    );
    const pending = link.send(new Request("http://x/"));
    await tick(10);
    await link.close(new LinkLostError("The handler was lost while this request was in flight"));
    await expect(pending).rejects.toThrow(/may or may not have been applied/);
    release();
    await expect(link.send(new Request("http://x/"))).rejects.toThrow(LinkLostError);
  });

  it("a body mid-stream fails when the link is closed", async () => {
    const { handler } = endless();
    const { link } = await linked(handler);
    const response = await link.send(new Request("http://x/"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await link.close(new LinkLostError("The ServiceWorker was lost while this call was in flight"));
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) break;
      })(),
    ).rejects.toThrow(/ServiceWorker was lost/);
  });

  it("the handler's teardown fails the caller instead of hanging", async () => {
    const { handler } = endless();
    const { link, stop } = await linked(handler);
    const response = await link.send(new Request("http://x/"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await stop();
    await expect(
      Promise.race([
        (async () => {
          for (;;) if ((await reader.read()).done) return "done";
        })(),
        tick(1000).then(() => "hung"),
      ]),
    ).rejects.toThrow();
  });
});
