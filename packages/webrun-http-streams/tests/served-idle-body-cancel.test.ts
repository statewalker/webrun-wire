import type { Duplex } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import { fetchOverDuplex, serveFetchOverDuplex } from "../src/fetch.js";

/**
 * A served response body that is IDLE — no chunk pending, as an SSE stream
 * between events or a long poll — is cancelled as soon as the exchange is torn
 * down, not when its next chunk comes (which may be never).
 *
 * A transport tears an exchange down with `return()` (or `throw()`) on the
 * serving side's output, without waiting. On an async generator that call is
 * queued behind the `next()` in flight, and that `next()` waits inside the
 * serving code for `reader.read()` on the idle body: so the body's `cancel()`
 * — what releases the handler's timers, subscriptions, cursors — never ran.
 *
 * The same holds for the two other streams this package reads from on someone
 * else's behalf: the request body a served handler reads (a caller that stops
 * sending, then goes away), and the upload a caller streams (a fetch aborted
 * while the upload waits for its next chunk).
 */

/** A body that sends one chunk and then waits for good, noting its cancellations. */
function idleBody() {
  const cancels: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
    },
    cancel(reason) {
      cancels.push(reason);
    },
  });
  return { stream, cancels };
}

/** A handler answering with an idle body; the server's output kept, as a transport holds it. */
function idleServer() {
  const body = idleBody();
  let output: AsyncGenerator<Uint8Array> | undefined;
  const server = serveFetchOverDuplex(
    async () => new Response(body.stream, { headers: { "content-type": "text/event-stream" } }),
  );
  const call: Duplex = (input) => {
    output = server(input);
    return output;
  };
  return { cancels: body.cancels, call, output: () => output };
}

async function until(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** Starts the exchange and reads the head and the first chunk; the body is idle after that. */
async function opened(call: Duplex, signal?: AbortSignal) {
  const response = await fetchOverDuplex(call, new Request("http://x/events", { signal }));
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("data: hello\n\n");
  // The next read waits inside the server for the idle body.
  const next = reader.read().catch((error: unknown) => error);
  await settle();
  return { reader, next };
}

describe("an idle served response body", () => {
  it("is cancelled at once, with a reason, when the transport calls return() on the output", async () => {
    const { cancels, call, output } = idleServer();
    await opened(call);
    // The `next()` the transport has in flight: it settles, it does not reject.
    const inFlight = output()?.next();
    void output()?.return(undefined); // as a transport does: not awaited
    await until(() => cancels.length > 0);
    expect(String((cancels[0] as Error | undefined)?.message)).toContain(
      "abandoned before it was over",
    );
    await expect(inFlight).resolves.toEqual({ done: true, value: undefined });
    await settle();
    expect(cancels).toHaveLength(1);
  });

  it("is cancelled at once with the error given to throw() on the output", async () => {
    const { cancels, call, output } = idleServer();
    await opened(call);
    const failure = new Error("transport died");
    void output()
      ?.throw(failure)
      .catch(() => {});
    await until(() => cancels.length > 0);
    expect(cancels[0]).toBe(failure);
    await settle();
    expect(cancels).toHaveLength(1);
  });

  it("is cancelled at once when the caller aborts its fetch", async () => {
    const { cancels, call } = idleServer();
    const controller = new AbortController();
    const { next } = await opened(call, controller.signal);
    controller.abort();
    expect(await next).toBeInstanceOf(Error);
    await until(() => cancels.length > 0);
    expect(cancels[0]).toBeInstanceOf(Error);
    await settle();
    expect(cancels).toHaveLength(1);
  });

  it("is cancelled at once when the caller cancels the response body", async () => {
    const { cancels, call } = idleServer();
    const { reader } = await opened(call);
    await reader.cancel();
    await until(() => cancels.length > 0, 1_500);
    await settle();
    expect(cancels).toHaveLength(1);
  });
});

describe("a served body that completes or fails", () => {
  it("is not cancelled when it ends normally, nor by a return() after it", async () => {
    const cancels: unknown[] = [];
    let output: AsyncGenerator<Uint8Array> | undefined;
    const server = serveFetchOverDuplex(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("one"));
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("two"));
                controller.close();
              }, 10);
            },
            cancel(reason) {
              cancels.push(reason);
            },
          }),
        ),
    );
    const call: Duplex = (input) => {
      output = server(input);
      return output;
    };
    const response = await fetchOverDuplex(call, new Request("http://x/"));
    expect(await response.text()).toBe("onetwo");
    await output?.return(undefined);
    await settle();
    expect(cancels).toEqual([]);
  });

  it("still fails the caller's read when the body errors", async () => {
    const server = serveFetchOverDuplex(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("one"));
              setTimeout(() => controller.error(new Error("producer failed")), 10);
            },
          }),
        ),
    );
    const response = await fetchOverDuplex(server, new Request("http://x/"));
    await expect(response.text()).rejects.toThrow();
  });
});

describe("an idle request body", () => {
  it("a served handler's pending read fails at once when the transport calls return()", async () => {
    let read: Promise<unknown> | undefined;
    let output: AsyncGenerator<Uint8Array> | undefined;
    const server = serveFetchOverDuplex(async (request) => {
      const reader = (request.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      read = reader.read().then(
        () => "settled",
        (error: unknown) => error,
      );
      return new Response("accepted", { status: 202 });
    });
    const call: Duplex = (input) => {
      output = server(input);
      return output;
    };
    const upload = idleBody();
    const response = await fetchOverDuplex(
      call,
      new Request("http://x/upload", {
        method: "POST",
        body: upload.stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(await response.text()).toBe("accepted");
    expect(read).toBeDefined();
    void output?.return(undefined);
    let outcome: unknown;
    void read?.then((value) => {
      outcome = value;
    });
    await until(() => outcome !== undefined);
    expect(String((outcome as Error).message)).toContain("abandoned before it was over");
  });

  it("a caller's idle upload is cancelled at once, with a reason, when its fetch aborts", async () => {
    const upload = idleBody();
    const server = serveFetchOverDuplex(async (request) => {
      // Reads the first chunk, then waits for the rest, which never comes.
      await new Response(request.body).text();
      return new Response("unreachable");
    });
    const controller = new AbortController();
    const pending = fetchOverDuplex(
      server,
      new Request("http://x/upload", {
        method: "POST",
        body: upload.stream,
        duplex: "half",
        signal: controller.signal,
      } as RequestInit),
    ).catch((error: unknown) => error);
    await settle();
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await until(() => upload.cancels.length > 0);
    expect(upload.cancels[0]).toBeInstanceOf(Error);
    await settle();
    expect(upload.cancels).toHaveLength(1);
  });
});
