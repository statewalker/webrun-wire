import { callChannel } from "../core/data-calls.js";
import {
  createWebSocketClass,
  type PortWebSocketClass,
  type WebSocketClassOptions,
  type WebSocketConnection,
} from "../ws/client.js";
import { WS_CONNECT_CALL } from "./protocol.js";

/**
 * Opens the transport of a socket through the ServiceWorker controlling this
 * page, for a page that has no adapter of its own: content a handler serves
 * under the same-origin dispatcher, or under a relay. The ServiceWorker
 * routes `url` like a fetch, and the handler accepts or refuses the upgrade.
 */
export async function connectWebSocketThroughServiceWorker(
  url: string | URL,
  protocols: string[] = [],
  container: ServiceWorkerContainer = navigator.serviceWorker,
): Promise<WebSocketConnection> {
  const worker = container.controller;
  if (!worker) throw new Error("This page is not controlled by a ServiceWorker");
  const httpUrl = new URL(`${url}`, globalThis.location?.href);
  if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
  else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
  return await callChannel<WebSocketConnection>(worker, WS_CONNECT_CALL, {
    url: `${httpUrl}`,
    protocols,
  });
}

/**
 * A WHATWG `WebSocket` class over `connectWebSocketThroughServiceWorker`.
 * Install it where the page's code expects `WebSocket`, e.g.
 * `globalThis.WebSocket = serviceWorkerWebSocketClass()` in content that only
 * talks to its own handlers.
 */
export function serviceWorkerWebSocketClass(options?: WebSocketClassOptions): PortWebSocketClass {
  return createWebSocketClass(
    (url, protocols) => connectWebSocketThroughServiceWorker(url, protocols),
    options,
  );
}
