import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { serializeError } from "@statewalker/webrun-streams";
import {
  type ChannelCallHandler,
  callChannel,
  callChannelWithin,
  unwrapTransfer,
  withTransfer,
} from "../core/data-calls.js";
import type { MessageTarget } from "../core/message-target.js";
import {
  awaitActiveServiceWorker,
  DEFAULT_SERVICE_WORKER_TIMEOUT,
} from "../core/service-worker-control.js";
import { handleHttpRequests, sendHttpRequest } from "../http/http-send-recieve.js";
import {
  connectHttpLink,
  HTTP_LINK_PROTOCOL,
  type HttpLinkOptions,
  serveHttpLink,
} from "../link/http-link.js";
import {
  createWebSocketClass,
  type PortWebSocketClass,
  type WebSocketClassOptions,
  type WebSocketConnection,
} from "../ws/client.js";
import { serveWebSocketUpgrade } from "../ws/upgrade.js";

export * from "./split-service-url.js";

/**
 * The URL of this module, kept in a variable on purpose. Bundlers (Vite
 * among them) rewrite every literal `new URL("<path>", import.meta.url)` into
 * an emitted asset at build time, before tree-shaking — so the defaults below
 * made every Vite consumer of this entry emit a dead copy of the package's
 * own `dist/index.js` (`"../"` resolves to the package, hence to its `main`).
 * Resolving against a variable is the same URL at run time and invisible to
 * that transform.
 */
const moduleUrl: string = import.meta.url;

/**
 * Returns a MessagePort that transparently bridges messages to/from the
 * page's ServiceWorker: the one controlling the page, or — when the page is
 * not controlled (a hard reload, or a page Firefox left uncontrolled) — the
 * active worker of `registration`, which answers messages all the same.
 */
export function newServiceWorkerPort(registration?: ServiceWorkerRegistration): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const worker = navigator.serviceWorker.controller ?? registration?.active;
    worker?.postMessage(event.data, [...event.ports]);
  };
  navigator.serviceWorker.addEventListener("message", (event) => {
    channel.port1.postMessage(event.data, [...event.ports]);
  });
  return channel.port2;
}

export interface InitServiceWorkerOptions {
  swUrl: string;
  scopeUrl?: string;
  type?: WorkerType;
  /**
   * Upper bound, in ms, for the wait for the worker to activate; past it the
   * promise rejects with a `ServiceWorkerControlError`. Default
   * `DEFAULT_SERVICE_WORKER_TIMEOUT` (30 s).
   */
  timeout?: number;
}

/**
 * Registers a ServiceWorker and resolves with it once it is activated: the
 * worker controlling the page, or the registration's active worker when the
 * page is not controlled. Messaging works either way, which is all the relay
 * needs; nothing here waits for control, because an uncontrolled page (hard
 * reload; Firefox) may never get it. Rejects with a
 * `ServiceWorkerControlError` if activation takes longer than `timeout`.
 */
export async function initServiceWorker(options: InitServiceWorkerOptions): Promise<ServiceWorker> {
  return (await registerServiceWorker(options)).worker;
}

async function registerServiceWorker({
  swUrl,
  scopeUrl,
  type,
  timeout = DEFAULT_SERVICE_WORKER_TIMEOUT,
}: InitServiceWorkerOptions): Promise<{
  registration: ServiceWorkerRegistration;
  worker: ServiceWorker;
}> {
  const registration = await navigator.serviceWorker.register(swUrl, { type, scope: scopeUrl });
  const active = await awaitActiveServiceWorker(registration, { timeout });
  return { registration, worker: navigator.serviceWorker.controller ?? active };
}

export interface ServiceOptions extends HttpLinkOptions {
  key: string;
  /**
   * Where this service is mounted on the relay origin, e.g. `/` or `/peers/`.
   * Omitted, the service stays reachable at `/~<key>/`, as before mounts.
   */
  path?: string;
  port: MessageTarget;
}

/**
 * What a service answers to a `CONNECT` that speaks `HTTP_LINK_PROTOCOL`. A
 * service of version 1 answers `true` instead, and the caller then falls back
 * to version 1's transport: both ends of a call must speak the same one, and
 * the relay, the caller and the service may each run another version.
 */
export interface ConnectReply {
  accepted: true;
  wire: string;
}

/** A `CONNECT` asking a service for a socket. */
export interface WebSocketConnectParams {
  type: "ws";
  key: string;
  url: string;
  protocols?: string[];
  headers?: [string, string][];
}

/**
 * Serves a service's side of one `CONNECT`: an HTTP link on `callPort`, or a
 * WebSocket upgrade run through `handler`.
 */
export async function answerConnect(
  handler: HttpHandler,
  data: unknown,
  callPort: MessagePort | undefined,
  options: HttpLinkOptions = {},
): Promise<unknown> {
  const params = (data ?? {}) as { type?: string; wire?: string };
  if (params.type === "ws") {
    callPort?.close();
    const { url, protocols = [], headers } = params as WebSocketConnectParams;
    const result = await serveWebSocketUpgrade(handler, { url, protocols, headers });
    if (!result.ok) throw new Error(result.message);
    const connection: WebSocketConnection = { port: result.port, protocol: result.protocol };
    return withTransfer(connection, [result.port]);
  }
  if (!callPort) throw new Error("A CONNECT for HTTP carries a port");
  if (params.wire === HTTP_LINK_PROTOCOL) {
    await serveHttpLink(callPort, handler, options);
    return { accepted: true, wire: HTTP_LINK_PROTOCOL } satisfies ConnectReply;
  }
  // A caller or relay of version 1.
  handleHttpRequests(callPort, handler);
  return true;
}

/**
 * Registers `handler` as the server for the given service `key` on the relay:
 * it answers HTTP requests and WebSocket upgrades. Returns a function that
 * unregisters the service; its promise settles once the relay acknowledged.
 */
export async function initHttpService(
  handler: HttpHandler,
  { key, path, port, streamTimeout }: ServiceOptions,
): Promise<() => Promise<void>> {
  return await registerConnectionsHandler({
    key,
    path,
    communicationPort: port,
    handler: (_event, data, callPort) =>
      answerConnect(handler, data, callPort, { streamTimeout }) as Promise<boolean>,
  });
}

/**
 * Sends a `Request` to the service registered under `key` on the relay and
 * resolves with the corresponding `Response`, whose body streams with
 * backpressure.
 */
export async function callHttpService(
  request: Request,
  { key, port, streamTimeout }: ServiceOptions,
): Promise<Response> {
  const channel = new MessageChannel();
  const reply = await callChannel<boolean | ConnectReply>(
    port,
    "CONNECT",
    { key, type: "http", wire: HTTP_LINK_PROTOCOL },
    channel.port2,
  );
  if (!reply) {
    channel.port1.close();
    throw new Error(`No service with key "${key}"`);
  }
  return await sendOverConnection(channel.port1, reply, request, { streamTimeout });
}

/**
 * Sends `request` on a port a service accepted with `reply`: over an HTTP link
 * when the service speaks `HTTP_LINK_PROTOCOL`, over version 1's transport
 * when it answered `true`. The link is closed once the response is done.
 */
export async function sendOverConnection(
  port: MessagePort,
  reply: boolean | ConnectReply,
  request: Request,
  options: HttpLinkOptions = {},
): Promise<Response> {
  if (reply === true) return await sendHttpRequest(port, request);
  const link = await connectHttpLink(port, options);
  try {
    const response = await link.send(request);
    void link.whenIdle().then(() => link.close());
    return response;
  } catch (error) {
    await link.close();
    throw error;
  }
}

/**
 * Opens the transport of a socket to the service registered under `key` on
 * the relay: the service runs the upgrade through its handler, and the
 * socket's port comes back through the relay. After that, the socket runs
 * between the caller and the service directly.
 */
export async function callWebSocketService(
  url: string | URL,
  protocols: string[],
  { key, port, timeout = 15_000 }: Pick<ServiceOptions, "key" | "port"> & { timeout?: number },
): Promise<WebSocketConnection> {
  const httpUrl = new URL(`${url}`, globalThis.location?.href);
  if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
  else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
  const channel = new MessageChannel();
  try {
    // Bounded: a relay worker or a service of version 1 cannot answer a
    // socket request (the first fails to pass the port on, the second
    // answers `true`), and the caller must not wait for ever.
    const reply = await callChannelWithin<unknown>(
      timeout,
      port,
      "CONNECT",
      { type: "ws", key, url: `${httpUrl}`, protocols } satisfies WebSocketConnectParams,
      channel.port2,
    );
    const connection = reply as Partial<WebSocketConnection> | null;
    if (!(connection?.port instanceof MessagePort)) {
      throw new Error(`The service "${key}" does not accept WebSockets (an older version?)`);
    }
    return { port: connection.port, protocol: connection.protocol ?? "" };
  } finally {
    channel.port1.close();
  }
}

/**
 * A WHATWG `WebSocket` class whose sockets reach the service registered under
 * `key` on the relay.
 */
export function relayWebSocketClass(
  service: Pick<ServiceOptions, "key" | "port">,
  options?: WebSocketClassOptions,
): PortWebSocketClass {
  return createWebSocketClass(
    (url, protocols) => callWebSocketService(url, protocols, service),
    options,
  );
}

export interface RelayWindowHandlerOptions {
  swUrl?: string;
  scopeUrl?: string;
  /** Passed to `initServiceWorker`: how long to wait for the relay worker to activate. */
  timeout?: number;
}

/**
 * Returns a `window.onmessage` handler for use inside the relay iframe:
 * it accepts a CONNECT message, starts the relay ServiceWorker, and bridges
 * the parent's MessagePort with the SW. If the worker cannot be started, every
 * call the parent makes on that port is answered with the error, so the
 * parent's `initHttpService` / `callHttpService` reject instead of waiting.
 */
export function getRelayWindowMessageHandler({
  swUrl = `${new URL("./relay-sw.js", moduleUrl)}`,
  scopeUrl = `${new URL("./", moduleUrl)}`,
  timeout,
}: RelayWindowHandlerOptions = {}): (ev: MessageEvent) => Promise<void> {
  let externalPort: MessagePort | undefined;
  return async (ev) => {
    if (ev.data?.type !== "CONNECT") return;
    const newExternalPort = ev.ports?.[0];
    if (!newExternalPort) return;
    if (externalPort) {
      newExternalPort.close();
      return;
    }
    externalPort = newExternalPort;
    let registration: ServiceWorkerRegistration;
    try {
      ({ registration } = await registerServiceWorker({ swUrl, scopeUrl, timeout }));
    } catch (error) {
      const serialized = serializeError(error);
      externalPort.onmessage = (event) => event.ports[0]?.postMessage({ error: serialized });
      throw error;
    }
    const serviceWorkerPort = newServiceWorkerPort(registration);
    serviceWorkerPort.onmessage = (event) => {
      externalPort?.postMessage(event.data, [...event.ports]);
    };
    externalPort.onmessage = (event) => {
      serviceWorkerPort.postMessage(event.data, [...event.ports]);
    };
  };
}

export interface RemoteRelayChannelOptions {
  baseUrl?: URL;
  url?: URL;
  container?: HTMLElement;
}

export interface RemoteRelayChannel {
  baseUrl: URL;
  port: MessagePort;
  close(): void;
}

/**
 * Embeds a hidden relay iframe, establishes a MessageChannel with it, and
 * returns the port to be used with `initHttpService` / `callHttpService`.
 */
export async function newRemoteRelayChannel({
  baseUrl = new URL("../public-relay/", moduleUrl),
  url = new URL("relay.html", baseUrl),
  container = document.body,
}: RemoteRelayChannelOptions = {}): Promise<RemoteRelayChannel> {
  const messageChannel = new MessageChannel();
  const { iframe, promise } = newIFrame(url);
  Object.assign(iframe.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    top: "-1000px",
    left: "-1000px",
    display: "block",
    opacity: "0",
    border: "none",
    outline: "none",
  });
  container.appendChild(iframe);
  promise.then(() => {
    iframe.contentWindow?.postMessage({ type: "CONNECT" }, "*", [messageChannel.port1]);
  });
  return {
    baseUrl,
    port: messageChannel.port2,
    close: () => {
      iframe.parentElement?.removeChild(iframe);
      messageChannel.port1.close();
      messageChannel.port2.close();
    },
  };

  function newIFrame(src: URL): { iframe: HTMLIFrameElement; promise: Promise<HTMLIFrameElement> } {
    const iframe = document.createElement("iframe");
    iframe.src = `${src}`;
    Object.assign(iframe.style, {
      padding: "0",
      margin: "0",
      border: "none",
      outline: "none",
      width: "100%",
      height: "100%",
    });
    return {
      iframe,
      promise: new Promise<HTMLIFrameElement>((resolve, reject) => {
        iframe.onerror = () => reject(new Error(`Failed to load ${src}`));
        iframe.onload = () => resolve(iframe);
      }),
    };
  }
}

export interface InitializeConnectionOptions {
  key: string;
  communicationPort: MessageTarget;
  [key: string]: unknown;
}

export async function initializeConnection({
  key,
  communicationPort,
  ...options
}: InitializeConnectionOptions): Promise<MessagePort | null> {
  const channel = new MessageChannel();
  const accepted = await callChannel<boolean>(
    communicationPort,
    "CONNECT",
    { key, ...options },
    channel.port2,
  );
  if (!accepted) {
    channel.port1.close();
    channel.port2.close();
    return null;
  }
  return channel.port1;
}

export interface RegisterConnectionsHandlerOptions {
  key: string;
  /** Where this service is mounted; see `ServiceOptions.path`. */
  path?: string;
  /**
   * Answers one `CONNECT`. Its result is the reply; wrap a result carrying a
   * port in `withTransfer`.
   */
  handler: (event: MessageEvent, data: unknown, port: MessagePort) => unknown | Promise<unknown>;
  communicationPort: MessageTarget;
}

/**
 * Registers `key` on the relay and answers its `CONNECT`s with `handler`.
 * Resolves with a function that unregisters it. That function's promise
 * settles once the relay acknowledged the `UNREGISTER`, so a caller can stop
 * its services and only then close the connection: closing first tore the
 * ports down before the message landed, and left the mount behind.
 */
export async function registerConnectionsHandler({
  key,
  path,
  handler,
  communicationPort,
}: RegisterConnectionsHandlerOptions): Promise<() => Promise<void>> {
  // `path` is omitted rather than sent as undefined: the worker distinguishes
  // "mounted at /" from "not mounted", and a key with no path keeps /~<key>/.
  await callChannel(communicationPort, "REGISTER", path == null ? { key } : { key, path });
  const stopAnswering = handleKeyedChannelCalls(
    communicationPort,
    "CONNECT",
    key,
    async (event, data, port) => await handler(event, data, port),
  );
  let stopped: Promise<void> | undefined;
  return () => {
    stopped ??= (async () => {
      try {
        await callChannel(communicationPort, "UNREGISTER", { key });
      } catch (error) {
        // The connection is gone, or the relay refused: nothing left to undo here.
        console.warn(`[relay] UNREGISTER of "${key}" failed`, error);
      } finally {
        // After the relay stopped routing here, not before: a CONNECT landing
        // in between would otherwise get no answer at all.
        stopAnswering();
      }
    })();
    return stopped;
  };
}

/**
 * `handleChannelCalls`, but only for calls whose `params.key` is `key`.
 *
 * ONE CONNECTION CARRIES SEVERAL SERVICES — an app at `/` and a mesh gateway
 * at `/peers/` over one relay iframe is the shape mounts exist for. Plain
 * `handleChannelCalls` cannot do that: every listener it has for a call type
 * runs on every message, and each is handed the SAME reply port and the SAME
 * transferred stream port. Two services then both serve the one channel the
 * worker is reading, and its response comes back with both bodies in it.
 *
 * WHY NOT A FILTER INSIDE THE HANDLER. Returning `false` for a foreign key
 * does not help: `handleChannelCalls` still replies, `callChannel` resolves on
 * the FIRST reply it receives, and the loser's `false` reaches the worker as
 * "the client refused" — a 403, non-deterministically. A service that is not
 * the addressee must stay SILENT and leave the transferred port untouched.
 *
 * Local to this module on purpose. `handleChannelCalls` is also used where a
 * call carries no key (REGISTER/UNREGISTER, and the worker's own CONNECT in
 * `index-sw.ts`, which is the other direction), so its semantics must not
 * change.
 */
function handleKeyedChannelCalls(
  target: MessageTarget,
  callType: string,
  key: string,
  handler: ChannelCallHandler,
): () => void {
  const listener = async (event: MessageEvent) => {
    const data = event.data as { type?: string; params?: { key?: unknown } } | null | undefined;
    if (!data || data.type !== callType) return;
    if (data.params?.key !== key) return;
    const [port, ...transfers] = (event.ports ?? []) as MessagePort[];
    const response: { result?: unknown; error?: unknown } = {};
    let transfer: Transferable[] = [];
    try {
      const result = await handler(event, data.params, ...transfers);
      ({ value: response.result, transfer } = unwrapTransfer(result));
    } catch (error) {
      response.error = serializeError(error);
    }
    port?.postMessage(response, transfer);
  };
  target.addEventListener("message", listener);
  target.start?.();
  return () => target.removeEventListener("message", listener);
}
