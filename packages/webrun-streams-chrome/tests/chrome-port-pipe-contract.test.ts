import { viewBytes } from "@statewalker/webrun-streams";
import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { afterEach, describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, chromePortPipe } from "../src/index.js";
import { FakeChromePort, fakeChromePortPair } from "./fake-chrome-port.js";

function harness(options?: { maxFrameBytes?: number }): MessagePipeHarness {
  const port = new FakeChromePort();
  const pipe = chromePortPipe(port, options);
  return {
    pipe,
    // The transport carries base64 text; bytes are what the suite injects.
    inject: (data) => {
      const bytes = viewBytes(data);
      port.receive(bytes ? bytesToBase64(bytes) : data);
    },
    sent: () => port.posted.map((json) => base64ToBytes(JSON.parse(json) as string)),
    endRemotely: () => port.dropFromPeer(),
  };
}

describeMessagePipe("chromePortPipe", () => harness(), {
  withMaxFrameBytes: (maxFrameBytes) => harness({ maxFrameBytes }),
});

describe("chromePortPipe", () => {
  const globals = globalThis as { chrome?: unknown };
  afterEach(() => {
    delete globals.chrome;
  });

  it("puts each frame on the port as one base64 string, and reads them back as bytes", async () => {
    const [a, b] = fakeChromePortPair();
    const left = chromePortPipe(a);
    const right = chromePortPipe(b);
    const got: Uint8Array[] = [];
    right.target.addEventListener("message", (e) => {
      got.push(e.data as Uint8Array);
    });
    const bytes = new Uint8Array(70_000).map((_, i) => i & 0xff);
    left.target.postMessage(bytes);
    left.target.postMessage(new Uint8Array(0));
    await expect.poll(() => got.length).toBe(2);
    expect(JSON.parse(a.posted[0] as string)).toBe(bytesToBase64(bytes));
    expect(got[0]).toEqual(bytes);
    expect(got[1]?.byteLength).toBe(0);
  });

  it("reports a 1 MiB payload ceiling by default", () => {
    const pipe = chromePortPipe(new FakeChromePort());
    expect(pipe.maxMessageSize).toBe(1024 * 1024);
    expect(pipe.target.maxMessageSize).toBe(1024 * 1024);
    expect(chromePortPipe(new FakeChromePort(), { maxMessageSize: 4096 }).maxMessageSize).toBe(
      4096,
    );
  });

  it("ends with chrome.runtime.lastError in its reason when the port disconnects", () => {
    globals.chrome = { runtime: { lastError: { message: "Could not establish connection." } } };
    const port = new FakeChromePort();
    const pipe = chromePortPipe(port, { name: "cs<->sw" });
    port.dropFromPeer();
    expect(pipe.signal.aborted).toBe(true);
    expect((pipe.signal.reason as Error).message).toBe(
      "cs<->sw: the chrome.runtime.Port disconnected (Could not establish connection.)",
    );
  });

  it("ends when a post throws, with the port's error", () => {
    const port = new FakeChromePort();
    const pipe = chromePortPipe(port);
    port.connected = false; // Chrome has not fired onDisconnect yet
    pipe.target.postMessage(new Uint8Array([1]));
    expect(pipe.signal.aborted).toBe(true);
    expect((pipe.signal.reason as Error).message).toMatch(/disconnected port/);
  });

  it("ends with a TypeError on a string that is not base64", () => {
    const port = new FakeChromePort();
    const pipe = chromePortPipe(port);
    port.receive("not base64!");
    expect(pipe.signal.reason).toBeInstanceOf(TypeError);
  });

  it("a local close disconnects the port: the other end's pipe ends", async () => {
    const [a, b] = fakeChromePortPair();
    const left = chromePortPipe(a);
    const right = chromePortPipe(b);
    await left.target.close();
    expect(a.connected).toBe(false);
    await expect.poll(() => right.signal.aborted).toBe(true);
    expect(a.onMessage.listeners.size).toBe(0);
    expect(a.onDisconnect.listeners.size).toBe(0);
  });
});
