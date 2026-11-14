import { describe, expect, it } from "vitest";
import { newHttpClientStub, newHttpServerStub } from "../src/http-stubs.js";

describe("http-stubs", () => {
  it("newHttpServerStub deserializes a Request and serializes the Response", async () => {
    const handler = async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("https://foo.bar/a");
      expect(request.headers.get("x-in")).toBe("yes");
      return new Response("ok", {
        status: 202,
        statusText: "Accepted",
        headers: { "x-out": "true", "content-type": "text/plain" },
      });
    };
    const stub = newHttpServerStub(handler);
    const result = await stub({
      options: {
        url: "https://foo.bar/a",
        method: "GET",
        headers: [["x-in", "yes"]],
      },
      content: (async function* () {})(),
    });
    expect(result.options.status).toBe(202);
    expect(result.options.statusText).toBe("Accepted");
    expect(result.options.headers["x-out"]).toBe("true");
    const decoder = new TextDecoder();
    const bytes: string[] = [];
    for await (const chunk of result.content) bytes.push(decoder.decode(chunk));
    expect(bytes.join("")).toBe("ok");
  });

  it("newHttpClientStub serializes a Request and deserializes the Response", async () => {
    const stub = newHttpClientStub(async (envelope) => {
      expect(envelope.options.url).toBe("https://foo.bar/b");
      expect(envelope.options.method).toBe("POST");
      const bytes: Uint8Array[] = [];
      for await (const chunk of envelope.content) bytes.push(chunk);
      const decoder = new TextDecoder();
      const body = bytes.map((b) => decoder.decode(b)).join("");
      expect(body).toBe("ping");
      const encoder = new TextEncoder();
      return {
        options: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
        },
        content: (async function* () {
          yield encoder.encode("pong");
        })(),
      };
    });
    const response = await stub(
      new Request("https://foo.bar/b", {
        method: "POST",
        body: "ping",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
  });

  it("reconstructs a 204 null-body-status response without attaching a body", async () => {
    // `new Response(body, { status: 204 })` throws — the client stub must emit a
    // bodyless response for 204/205/304 (a plain REST `DELETE` returns 204).
    const stub = newHttpClientStub(async () => ({
      options: { status: 204, statusText: "No Content", headers: {} },
      content: (async function* () {})(),
    }));
    const response = await stub(new Request("https://foo.bar/x", { method: "DELETE" }));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("returns 404 when the transport resolves to undefined", async () => {
    const stub = newHttpClientStub(async () => undefined);
    const response = await stub(new Request("https://foo.bar/missing"));
    expect(response.status).toBe(404);
  });
});

/**
 * The stubs' bodies are iterated by a transport, which tears them down with `return()` from
 * outside, often while a `next()` waits on an idle stream (an SSE stream between events). That
 * `return()` must reach the stream at once, not wait behind the read for a next chunk.
 */
describe("http-stubs with an idle body", () => {
  function idle() {
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

  async function until(predicate: () => boolean, timeoutMs = 100): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  it("newHttpServerStub's response content cancels the body at once on return()", async () => {
    const body = idle();
    const stub = newHttpServerStub(async () => new Response(body.stream));
    const result = await stub({
      options: { url: "https://foo.bar/events", method: "GET", headers: [] },
      content: (async function* () {})(),
    });
    const it = result.content[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(false);
    const inFlight = it.next();
    const returned = it.return?.();
    await until(() => body.cancels.length > 0);
    await expect(inFlight).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
    expect(body.cancels).toHaveLength(1);
  });

  it("newHttpServerStub's response content does not cancel a body read to its end", async () => {
    const cancels: unknown[] = [];
    const stub = newHttpServerStub(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
            },
            cancel(reason) {
              cancels.push(reason);
            },
          }),
        ),
    );
    const result = await stub({
      options: { url: "https://foo.bar/", method: "GET", headers: [] },
      content: (async function* () {})(),
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.content) chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe("ok");
    expect(cancels).toEqual([]);
  });

  it("newHttpClientStub's request content cancels an idle upload at once on return()", async () => {
    const upload = idle();
    let inFlight: Promise<unknown> | undefined;
    let returned: Promise<unknown> | undefined;
    const stub = newHttpClientStub(async (envelope) => {
      const it = envelope.content[Symbol.asyncIterator]();
      await it.next();
      inFlight = it.next();
      returned = it.return?.();
      return undefined;
    });
    await stub(
      new Request("https://foo.bar/upload", {
        method: "POST",
        body: upload.stream,
        duplex: "half",
      } as RequestInit),
    );
    await until(() => upload.cancels.length > 0);
    await expect(inFlight).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
    expect(upload.cancels).toHaveLength(1);
  });

  it("newHttpServerStub forwards only known RequestInit fields (#144)", async () => {
    let seen: Request | undefined;
    const stub = newHttpServerStub(async (request) => {
      seen = request;
      return new Response("ok");
    });
    const result = await stub({
      options: {
        url: "https://foo.bar/a",
        method: "GET",
        headers: [],
        // A GET with a body makes `new Request` throw; a peer must not be able to inject it.
        body: "injected",
        duplex: "half",
        window: "nope",
        cache: "no-store",
      },
      content: (async function* () {})(),
    });
    expect(result.options.status).toBe(200);
    expect(seen?.method).toBe("GET");
    expect(seen?.cache).toBe("no-store");
    expect(seen?.body).toBeNull();
  });

  it("carries every set-cookie across the stubs (#144)", async () => {
    const server = newHttpServerStub(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      headers.append("x-one", "1");
      return new Response("ok", { headers });
    });
    const client = newHttpClientStub((envelope) => server(envelope));
    const response = await client(new Request("https://foo.bar/c"));
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(response.headers.get("x-one")).toBe("1");
    expect(await response.text()).toBe("ok");
  });

  it("keeps the record-shaped headers for older peers (#144)", async () => {
    const server = newHttpServerStub(async () => {
      const headers = new Headers({ "x-one": "1" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(null, { headers });
    });
    const result = await server({
      options: { url: "https://foo.bar/a", method: "GET", headers: [] },
      content: (async function* () {})(),
    });
    expect(result.options.headers["x-one"]).toBe("1");
    expect(result.options.headerEntries).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
      ["x-one", "1"],
    ]);
    // A client given only the record (an older server) still builds the Response from it.
    const client = newHttpClientStub(async () => ({
      options: { status: 201, statusText: "Created", headers: { "x-two": "2" } },
      content: (async function* () {})(),
    }));
    const response = await client(new Request("https://foo.bar/d"));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-two")).toBe("2");
  });
});
