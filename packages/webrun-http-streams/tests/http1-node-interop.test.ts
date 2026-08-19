import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  connect as netConnect,
  type Socket,
} from "node:net";
import { describe, expect, it } from "vitest";
import { httpCodec } from "../src/http1/index.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** A node Socket yields Buffers, which are Uint8Arrays. */
const asByteSource = (socket: Socket) => socket as unknown as AsyncIterable<Uint8Array>;

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of body) out += dec.decode(chunk, { stream: true });
  return out + dec.decode();
}

describe("conformance against a real HTTP implementation", () => {
  it(
    "node:http parses a request we generated, and we parse its response",
    { timeout: 15000 },
    async () => {
      const seen: {
        method?: string;
        url?: string;
        headers?: Record<string, string | string[] | undefined>;
        body?: string;
      } = {};

      const server = createServer((req, res) => {
        seen.method = req.method;
        seen.url = req.url;
        seen.headers = { ...req.headers };
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(201, "Created", { "content-type": "text/plain" });
          res.end("pong");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const { port } = server.address() as AddressInfo;

      const socket = netConnect(port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });

      for await (const chunk of httpCodec.encodeRequest(
        {
          url: `http://127.0.0.1:${port}/api?a=1&b=two&empty=`,
          method: "POST",
          headers: [["X-Test", "yes"]],
        },
        [enc("hello-from-webrun"), enc("!")],
      )) {
        socket.write(chunk);
      }

      const decoded = await httpCodec.decodeResponse(asByteSource(socket), { method: "POST" });
      const bodyText = await text(decoded.body);

      // --- they parsed what we generated ---
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/api?a=1&b=two&empty="); // note 15 Q1: the query survives
      expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
      expect(seen.headers?.["x-test"]).toBe("yes");
      expect(seen.headers?.["transfer-encoding"]).toBe("chunked");
      expect(seen.body).toBe("hello-from-webrun!"); // note 15 Q2: a streamed body is not empty

      // --- we parsed what they generated ---
      expect(decoded.envelope.status).toBe(201);
      expect(decoded.envelope.statusText).toBe("Created");
      expect(bodyText).toBe("pong");

      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );

  it(
    "we parse a request node:http generated, and node:http parses our response",
    { timeout: 15000 },
    async () => {
      let decodedMethod = "";
      let decodedUrl = "";
      let decodedBody = "";
      let serverError: unknown;

      const netServer = createNetServer((socket: Socket) => {
        void (async () => {
          try {
            const decoded = await httpCodec.decodeRequest(asByteSource(socket));
            decodedMethod = decoded.envelope.method;
            decodedUrl = decoded.envelope.url;
            decodedBody = await text(decoded.body);
            for await (const chunk of httpCodec.encodeResponse(
              { status: 202, statusText: "Accepted", headers: [["X-Echo", decodedBody]] },
              [enc("from-us")],
              { method: decodedMethod },
            )) {
              socket.write(chunk);
            }
          } catch (err) {
            serverError = err;
          } finally {
            socket.end();
          }
        })();
      });
      await new Promise<void>((resolve) => netServer.listen(0, "127.0.0.1", () => resolve()));
      const { port } = netServer.address() as AddressInfo;

      const response = await new Promise<{ msg: IncomingMessage; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/echo?q=1&empty=",
              headers: { "x-test": "yes" },
            },
            (msg) => {
              const chunks: Buffer[] = [];
              msg.on("data", (c: Buffer) => chunks.push(c));
              msg.on("end", () => resolve({ msg, body: Buffer.concat(chunks).toString("utf8") }));
            },
          );
          req.on("error", reject);
          req.write("hello");
          req.end();
        },
      );

      expect(serverError).toBeUndefined();

      // --- we parsed what they generated ---
      expect(decodedMethod).toBe("POST");
      expect(decodedUrl).toBe(`http://127.0.0.1:${port}/echo?q=1&empty=`);
      expect(decodedBody).toBe("hello");

      // --- they parsed what we generated ---
      expect(response.msg.statusCode).toBe(202);
      expect(response.msg.statusMessage).toBe("Accepted");
      expect(response.msg.headers["x-echo"]).toBe("hello");
      expect(response.body).toBe("from-us");

      await new Promise<void>((resolve) => netServer.close(() => resolve()));
    },
  );

  // I3: proves the same HEAD plumbing that tests/http-streams.test.ts checks
  // against a loopback, this time against a real HTTP/1.1 implementation —
  // node:http suppresses the response body for a HEAD request itself, while
  // still sending the Content-Length it was given, so a client that gets the
  // request method wrong tries to read bytes a conforming server never sends.
  it(
    "HEAD: node:http answers our HEAD request, and we read no body from its response",
    { timeout: 15000 },
    async () => {
      const server = createServer((req, res) => {
        res.writeHead(200, "OK", { "content-type": "text/plain", "content-length": "5" });
        res.end("hello");
        // Close the connection once the response is flushed, so a client that
        // mistakenly tries to read a body (see the mutation this guards
        // against) fails fast with "body truncated" instead of hanging on a
        // keep-alive socket that never sends more bytes.
        res.on("finish", () => req.socket.end());
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const { port } = server.address() as AddressInfo;

      const socket = netConnect(port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });

      for await (const chunk of httpCodec.encodeRequest(
        { url: `http://127.0.0.1:${port}/x`, method: "HEAD", headers: [] },
        undefined,
      )) {
        socket.write(chunk);
      }

      const decoded = await httpCodec.decodeResponse(asByteSource(socket), { method: "HEAD" });
      expect(decoded.envelope.status).toBe(200);
      expect(decoded.envelope.headers.some(([k]) => k.toLowerCase() === "content-length")).toBe(
        true,
      );
      expect(await text(decoded.body)).toBe("");

      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );
});
