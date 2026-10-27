import { holdLock, newLockName } from "../link/locks.js";
import {
  createWebSocketClass,
  type PortWebSocketClass,
  type WebSocketClassOptions,
  type WebSocketConnection,
} from "../ws/client.js";
import {
  type FetchHandler,
  HandlerEndpoint,
  type HandlerEndpointOptions,
} from "./handler-endpoint.js";
import { WORKER_HELLO, type WorkerControlMessage } from "./protocol.js";

export interface ServeHttpInWorkerOptions
  extends Omit<HandlerEndpointOptions, "requestRelink" | "keepAlive"> {
  /** Where the page's messages arrive. Default `globalThis` (the worker's scope). */
  scope?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** Options of the `WebSocket` class (`service.WebSocket`). */
  webSocket?: WebSocketClassOptions;
}

/** What a worker serving HTTP can do besides serving. */
export interface WorkerHttpService {
  /**
   * Fetches through the ServiceWorker's router: a url under its scope reaches
   * the handler it routes to (another worker, a page), any other the network.
   * Needs no `fetch` event, so it works whether or not this worker is
   * controlled; a call that is in flight when the ServiceWorker dies fails
   * with `LinkLostError` rather than hanging, and the next waits for a link.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Opens the transport of a socket to the handler `url` routes to. */
  connectWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocketConnection>;
  /** A WHATWG `WebSocket` class over `connectWebSocket`. */
  readonly WebSocket: PortWebSocketClass;
  /** Whether the worker has a live link. */
  readonly linked: boolean;
  /** Stops serving; requests in flight fail. */
  close(): Promise<void>;
}

/**
 * Serves `handler` from a Dedicated Worker, on the links the page attaches
 * with `adapter.attachWorker(worker)`:
 *
 * ```ts
 * // worker.ts
 * const service = serveHttpInWorker(async (request) => new Response("hi"));
 * ```
 *
 * The worker holds an owner lock while it lives, so the ServiceWorker notices
 * at once when it is terminated. It watches the ServiceWorker's router lock,
 * and asks its page to attach it again when its links died and a call waits.
 * While calls through the router are in flight it asks its page every 20 s to
 * keep the ServiceWorker awake — only a message to the ServiceWorker object
 * counts as an event, and a worker cannot post one.
 */
export function serveHttpInWorker(
  handler: FetchHandler,
  options: ServeHttpInWorkerOptions = {},
): WorkerHttpService {
  const scope = options.scope ?? (globalThis as unknown as EventTarget);
  const ownerLock = newLockName("webrun-http-owner");
  const held = holdLock(ownerLock);
  const controls = new Set<MessagePort>();
  const tellPages = (message: WorkerControlMessage) => {
    for (const control of controls) control.postMessage(message);
  };
  const endpoint = new HandlerEndpoint(handler, {
    ...options,
    requestRelink: () => tellPages({ type: "relink" }),
    keepAlive: () => tellPages({ type: "keepalive" }),
  });

  const onMessage = (event: Event) => {
    const { data, ports } = event as MessageEvent;
    if ((data as { type?: unknown } | null)?.type !== WORKER_HELLO) return;
    const control = ports?.[0];
    if (!control) return;
    controls.add(control);
    control.onmessage = (message) => {
      const msg = message.data as WorkerControlMessage;
      if (msg?.type === "link") {
        const [down, ctl, up] = message.ports;
        if (down) void endpoint.link(msg.key, { down, ctl, up }, msg.routerLock);
      } else if (msg?.type === "unlink") {
        void endpoint.unlink(msg.key);
      }
    };
    void held.then(() =>
      control.postMessage({ type: "ready", ownerLock } satisfies WorkerControlMessage),
    );
  };
  scope.addEventListener("message", onMessage);

  const baseUrl = () => (globalThis as { location?: { href: string } }).location?.href;
  const connectWebSocket = (url: string | URL, protocols: string[] = []) => {
    const httpUrl = new URL(`${url}`, baseUrl());
    if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
    else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
    return endpoint.connectWebSocket(`${httpUrl}`, protocols);
  };
  let WebSocketClass: PortWebSocketClass | undefined;

  return {
    fetch(input, init) {
      const request =
        input instanceof Request && init === undefined
          ? input
          : new Request(input instanceof Request ? input : new URL(`${input}`, baseUrl()), init);
      return endpoint.fetch(request);
    },
    connectWebSocket,
    get WebSocket() {
      WebSocketClass ??= createWebSocketClass(connectWebSocket, options.webSocket);
      return WebSocketClass;
    },
    get linked() {
      return endpoint.linked;
    },
    async close() {
      scope.removeEventListener("message", onMessage);
      await endpoint.close();
      for (const control of controls) control.close();
      controls.clear();
      (await held)();
    },
  };
}
