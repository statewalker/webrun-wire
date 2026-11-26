import type { MessagePipe } from "@statewalker/webrun-streams";
import { chromePortPipe, messagePortPipe, relayPipes } from "../src/index.js";
import { type FakeChromePort, fakeChromePortPair } from "./fake-chrome-port.js";

/** The three parts of an extension connection, as the browser would wire them. */
export interface ExtensionConnection {
  /** The page's pipe: a `MessagePort` the content script handed over. */
  page: MessagePipe;
  /** The service worker's pipe: the `chrome.runtime.Port` it accepted. */
  worker: MessagePipe;
  /** The content script's end of the chrome port, to stop the worker under it. */
  contentPort: FakeChromePort;
  /** Stops the relay and releases everything. */
  close(): Promise<void>;
}

/**
 * page ⇄ content script ⇄ service worker: a `MessageChannel` between the page
 * and the content script, a (fake) `chrome.runtime.Port` between the content
 * script and the worker, and `relayPipes` in the content script.
 */
export function extensionConnection(
  options: { maxMessageSize?: number } = {},
): ExtensionConnection {
  const [contentPort, workerPort] = fakeChromePortPair();
  const channel = new MessageChannel();
  const page = messagePortPipe(channel.port2, { name: "page<->cs", ...options });
  const toPage = messagePortPipe(channel.port1, { name: "cs<->page" });
  const toWorker = chromePortPipe(contentPort, { name: "cs<->sw" });
  const worker = chromePortPipe(workerPort, { name: "sw<->cs", ...options });
  const stop = relayPipes(toPage, toWorker);
  return {
    page,
    worker,
    contentPort,
    async close() {
      await stop();
      await page.target.close();
      await worker.target.close();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
