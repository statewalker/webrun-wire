import { fromReadableStream, toReadableStream } from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/core/message-target.js";
import { newRegistry } from "../src/core/registry.js";
import { handleHttpRequests, sendHttpRequest } from "../src/http/http-send-recieve.js";

function asTarget(port: MessagePort): MessageTarget {
  return port as unknown as MessageTarget;
}

function newHttpRequest(): Request {
  async function* generateText() {
    const encoder = new TextEncoder();
    for (let i = 0; i < 10; i++) {
      yield encoder.encode(`Hello-${i}\n`);
    }
  }
  return new Request("https://foo.bar.baz/~abc/new/resource", {
    method: "POST",
    duplex: "half",
    headers: {
      "Content-Type": "text/plain",
      "x-field-from-request": "abc",
    },
    body: toReadableStream(generateText()),
  } as RequestInit & { duplex: "half" });
}

async function echoHandler(request: Request): Promise<Response> {
  const url = request.url;
  let key = "";
  let path = "";
  let baseUrl = "";
  url.replace(/^(.*~([^/]*)\/)(.*)*/, (_, b, k, p) => {
    baseUrl = b as string;
    key = k as string;
    path = p as string;
    return "";
  });

  const content: string[] = [];
  if (request.method === "POST" && request.body) {
    const decoder = new TextDecoder();
    for await (const chunk of fromReadableStream(request.body as ReadableStream<Uint8Array>)) {
      content.push(decoder.decode(chunk));
    }
  }

  const body = { key, path, baseUrl, url, message: "Hello!", content };
  const headers = new Headers();
  for (const [k, v] of request.headers) headers.set(k, v);
  headers.set("Content-Type", "text/json");
  headers.set("X-Foo-Bar", "baz");
  return new Response(JSON.stringify(body), { headers });
}

describe("HTTP send/receive over a MessageChannel", () => {
  it("roundtrips a streaming POST request end-to-end", async () => {
    const [register, cleanup] = newRegistry();
    try {
      const { port1, port2 } = new MessageChannel();
      register(() => {
        port1.close();
        port2.close();
      });
      register(handleHttpRequests(asTarget(port1), echoHandler));

      const response = await sendHttpRequest(asTarget(port2), newHttpRequest());

      expect([...response.headers]).toEqual(
        expect.arrayContaining([
          ["content-type", "text/json"],
          ["x-field-from-request", "abc"],
          ["x-foo-bar", "baz"],
        ]),
      );

      const json = (await response.json()) as {
        key: string;
        path: string;
        baseUrl: string;
        url: string;
        message: string;
        content: string[];
      };
      expect(json).toEqual({
        key: "abc",
        path: "new/resource",
        baseUrl: "https://foo.bar.baz/~abc/",
        url: "https://foo.bar.baz/~abc/new/resource",
        message: "Hello!",
        content: Array.from({ length: 10 }, (_, i) => `Hello-${i}\n`),
      });
    } finally {
      cleanup();
    }
  });
});
