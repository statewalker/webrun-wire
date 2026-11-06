import { afterEach, describe, expect, it } from "vitest";
import { serveHttpLink } from "../src/link/http-link.js";
import { WORKER_HELLO, type WorkerControlMessage } from "../src/sw/protocol.js";
import { serveHttpInWorker } from "../src/sw/worker-service.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A worker serving through `serveHttpInWorker`, and the page's end of its control port. */
function workerWithPage() {
  const scope = new EventTarget();
  const service = serveHttpInWorker(() => new Response("worker"), {
    scope,
    relinkRetryMs: 20,
    relinkTimeoutMs: 5_000,
  });
  const control = new MessageChannel();
  const received: WorkerControlMessage[] = [];
  control.port1.onmessage = (event) => received.push(event.data as WorkerControlMessage);
  scope.dispatchEvent(
    new MessageEvent("message", { data: { type: WORKER_HELLO }, ports: [control.port2] }),
  );
  closers.push(
    () => service.close(),
    () => control.port1.close(),
  );

  /** Sends the worker a link whose `up` end answers with `text`. */
  const sendLink = async (seq: number, text: string) => {
    const down = new MessageChannel();
    const ctl = new MessageChannel();
    const up = new MessageChannel();
    const stopUp = await serveHttpLink(up.port1, () => new Response(text));
    closers.push(
      () => stopUp(),
      () => down.port1.close(),
      () => ctl.port1.close(),
    );
    control.port1.postMessage({ type: "link", key: "k", seq } satisfies WorkerControlMessage, [
      down.port2,
      ctl.port2,
      up.port2,
    ]);
  };
  const relinks = () => received.filter((message) => message.type === "relink");
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };
  return { service, control, sendLink, relinks, until };
}

describe("serveHttpInWorker: relink requests", () => {
  it("say which link the worker has, so the page can tell a lost link from one on its way", async () => {
    const { service, control, sendLink, relinks, until } = workerWithPage();

    // A call before the first link arrived: the worker asks, having seen none.
    const first = service.fetch("http://localhost/a");
    await until(() => relinks().length > 0);
    expect(relinks()[0]).toEqual({ type: "relink", seen: 0 });

    // Link 1 arrives: the waiting call goes through it.
    await sendLink(1, "via link 1");
    expect(await (await first).text()).toBe("via link 1");

    // Link 1 is dropped; the next call asks again, having seen link 1.
    control.port1.postMessage({ type: "unlink", key: "k" } satisfies WorkerControlMessage);
    await until(() => !service.linked);
    const before = relinks().length;
    const second = service.fetch("http://localhost/b");
    await until(() => relinks().length > before);
    expect(relinks()[before]).toEqual({ type: "relink", seen: 1 });

    await sendLink(2, "via link 2");
    expect(await (await second).text()).toBe("via link 2");
  });
});
