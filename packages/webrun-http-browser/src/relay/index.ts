import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { serializeError } from "@statewalker/webrun-streams";
import { type ChannelCallHandler, callChannel } from "../core/data-calls.js";
import type { MessageTarget } from "../core/message-target.js";
import { newRegistry } from "../core/registry.js";
import {
  awaitActiveServiceWorker,
  DEFAULT_SERVICE_WORKER_TIMEOUT,
} from "../core/service-worker-control.js";
import { handleHttpRequests, sendHttpRequest } from "../http/http-send-recieve.js";

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

export interface ServiceOptions {
  key: string;
  /**
   * Where this service is mounted on the relay origin, e.g. `/` or `/peers/`.
   * Omitted, the service stays reachable at `/~<key>/`, as before mounts.
   */
  path?: string;
  port: MessageTarget;
}

/**
 * Registers `handler` as the server for the given service `key` on the relay.
 * Returns a cleanup function that unregisters the service.
 */
export async function initHttpService(
  handler: HttpHandler,
  { key, path, port }: ServiceOptions,
): Promise<() => void> {
  return await registerConnectionsHandler({
    key,
    path,
    communicationPort: port,
    handler: async (_event, _data, callPort) => {
      handleHttpRequests(callPort, handler);
      return true;
    },
  });
}

/**
 * Sends a `Request` to the service registered under `key` on the relay and
 * resolves with the corresponding `Response`.
 */
export async function callHttpService(
  request: Request,
  { key, port }: ServiceOptions,
): Promise<Response> {
  const callPort = await initializeConnection({ key, communicationPort: port });
  if (!callPort) throw new Error(`No service with key "${key}"`);
  return await sendHttpRequest(callPort, request);
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
  swUrl = `${new URL("./index-sw.js", moduleUrl)}`,
  scopeUrl = `${new URL("../", moduleUrl)}`,
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
  handler: (event: MessageEvent, data: unknown, port: MessagePort) => boolean | Promise<boolean>;
  communicationPort: MessageTarget;
}

export async function registerConnectionsHandler({
  key,
  path,
  handler,
  communicationPort,
}: RegisterConnectionsHandlerOptions): Promise<() => void> {
  const [register, cleanup] = newRegistry();
  // `path` is omitted rather than sent as undefined: the worker distinguishes
  // "mounted at /" from "not mounted", and a key with no path keeps /~<key>/.
  await callChannel(communicationPort, "REGISTER", path == null ? { key } : { key, path });
  register(() => callChannel(communicationPort, "UNREGISTER", { key }));
  register(
    handleKeyedChannelCalls(communicationPort, "CONNECT", key, async (event, data, port) => {
      return await handler(event, data, port);
    }),
  );
  return cleanup;
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
    try {
      response.result = await handler(event, data.params, ...transfers);
    } catch (error) {
      response.error = serializeError(error);
    }
    port?.postMessage(response);
  };
  target.addEventListener("message", listener);
  target.start?.();
  return () => target.removeEventListener("message", listener);
}
