import type { HttpHandler } from "@statewalker/webrun-http-streams";
import { callChannel, handleChannelCalls } from "../core/data-calls.js";
import type { MessageTarget } from "../core/message-target.js";
import { newRegistry } from "../core/registry.js";
import { handleHttpRequests, sendHttpRequest } from "../http/http-send-recieve.js";

export * from "./split-service-url.js";

/**
 * Returns a MessagePort that transparently bridges messages to/from the
 * ServiceWorker controlling this page.
 */
export function newServiceWorkerPort(): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    navigator.serviceWorker.controller?.postMessage(event.data, [...event.ports]);
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
}

/**
 * Registers a ServiceWorker and resolves once it's activated and controlling the page.
 */
export async function initServiceWorker({
  swUrl,
  scopeUrl,
  type,
}: InitServiceWorkerOptions): Promise<ServiceWorker> {
  await navigator.serviceWorker.register(swUrl, { type, scope: scopeUrl });
  const worker = await getServiceWorkerController();
  await awaitServiceWorkerActivation(worker);
  return worker;
}

function getServiceWorkerController(): Promise<ServiceWorker> {
  return new Promise((resolve) => {
    const container = navigator.serviceWorker;
    if (container.controller) {
      resolve(container.controller);
      return;
    }
    const onChange = () => {
      if (!container.controller) return;
      resolve(container.controller);
      container.removeEventListener("controllerchange", onChange);
    };
    container.addEventListener("controllerchange", onChange);
  });
}

function awaitServiceWorkerActivation(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.state === "activated") {
      resolve();
      return;
    }
    const onStateChange = () => {
      if (worker.state !== "activated") return;
      worker.removeEventListener("statechange", onStateChange);
      resolve();
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

export interface ServiceOptions {
  key: string;
  port: MessageTarget;
}

/**
 * Registers `handler` as the server for the given service `key` on the relay.
 * Returns a cleanup function that unregisters the service.
 */
export async function initHttpService(
  handler: HttpHandler,
  { key, port }: ServiceOptions,
): Promise<() => void> {
  return await registerConnectionsHandler({
    key,
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
}

/**
 * Returns a `window.onmessage` handler for use inside the relay iframe:
 * it accepts a CONNECT message, starts the relay ServiceWorker, and bridges
 * the parent's MessagePort with the SW.
 */
export function getRelayWindowMessageHandler({
  swUrl = `${new URL("./index-sw.js", import.meta.url)}`,
  scopeUrl = `${new URL("../", import.meta.url)}`,
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
    await initServiceWorker({ swUrl, scopeUrl });
    const serviceWorkerPort = newServiceWorkerPort();
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
  baseUrl = new URL("../public-relay/", import.meta.url),
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
  handler: (event: MessageEvent, data: unknown, port: MessagePort) => boolean | Promise<boolean>;
  communicationPort: MessageTarget;
}

export async function registerConnectionsHandler({
  key,
  handler,
  communicationPort,
}: RegisterConnectionsHandlerOptions): Promise<() => void> {
  const [register, cleanup] = newRegistry();
  await callChannel(communicationPort, "REGISTER", { key });
  register(() => callChannel(communicationPort, "UNREGISTER", { key }));
  register(
    handleChannelCalls(communicationPort, "CONNECT", async (event, data, port) => {
      return await handler(event, data, port);
    }),
  );
  return cleanup;
}
