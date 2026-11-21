// A FilesRpc (@statewalker/webrun-files-rpc) served over a real WebSocket: serveMethods on each
// port the client opens, methodsClient on the client's port, msgpack over overPipe, the socket
// bridged by messageTargetOverWebSocket. The README's "Serve an object's methods" example.
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  errorCode,
  type FilesRpc,
  newFilesRpcClient,
  newFilesRpcServer,
} from "@statewalker/webrun-files-rpc";
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { callPort, methodsClient, overPipe, serveMethods } from "@statewalker/webrun-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { messageTargetOverWebSocket, openWebSocket, type WebSocketLike } from "../src/index.js";

const channelName = "files";
const FILES_METHODS = [
  "openRead",
  "readChunk",
  "closeRead",
  "openWrite",
  "writeChunk",
  "closeWrite",
  "abortWrite",
  "list",
  "stats",
  "exists",
  "mkdir",
  "remove",
  "move",
  "copy",
] as const satisfies readonly (keyof FilesRpc)[];

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A WebSocket server serving one FilesRpc, and a client port connected to it. */
async function connectFiles(): Promise<{
  rpc: FilesRpc;
  port: Awaited<ReturnType<typeof openPort>>;
}> {
  const server = newFilesRpcServer({ fs: new MemFilesApi(), chunkSize: 4 });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  cleanups.push(() => server.close());

  wss.on("connection", async (socket) => {
    const { target, signal } = messageTargetOverWebSocket(socket as unknown as WebSocketLike);
    const mux = await overPipe(target, { codec: msgpackCodec, side: "responder", signal })(
      (port) => {
        serveMethods(port, server, { channelName, methods: FILES_METHODS });
        return true;
      },
    );
    cleanups.push(() => mux.close());
  });

  const { port: address } = wss.address() as { port: number };
  const port = await openPort(`ws://127.0.0.1:${address}`);
  const rpc = methodsClient<FilesRpc>(port, { channelName, methods: FILES_METHODS });
  return { rpc, port };
}

async function openPort(url: string) {
  const ws = await openWebSocket({
    url,
    WebSocketCtor: NodeWebSocket as unknown as new (url: string) => WebSocketLike,
  });
  const { target, signal } = messageTargetOverWebSocket(ws);
  const mux = await overPipe(target, { codec: msgpackCodec, side: "initiator", signal })();
  cleanups.push(() => mux.close());
  return mux.openPort({ kind: "methods" });
}

describe("a FilesRpc over a WebSocket, through serveMethods / methodsClient", () => {
  it("writes and reads a file's bytes through webrun-files-rpc's client", async () => {
    const { rpc } = await connectFiles();
    const files = newFilesRpcClient({ rpc, chunkSize: 3 });
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);

    await files.write("/data/blob.bin", [bytes]);
    const read: number[] = [];
    for await (const chunk of files.read("/data/blob.bin")) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      read.push(...chunk);
    }
    expect(read).toEqual([...bytes]);
    expect(await files.exists("/data/blob.bin")).toBe(true);
    expect(await files.stats("/data/blob.bin")).toMatchObject({ kind: "file", size: 1000 });
  });

  it("rejects with the protocol's error code", async () => {
    const { rpc } = await connectFiles();
    const error = await rpc.readChunk("no-such-stream-0000", 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe("UNKNOWN_STREAM");
  });

  it("refuses a method the server does not serve", async () => {
    const { port } = await connectFiles();
    const call = callPort(port, { method: "close", args: [] }, { channelName });
    await expect(call).rejects.toMatchObject({ code: "ENOSYS" });
  });
});
