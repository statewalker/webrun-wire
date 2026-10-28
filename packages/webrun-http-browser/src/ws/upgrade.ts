import { errorMessage } from "../link/errors.js";
import { WS_PORT_PROTOCOL_VERSION } from "./frames.js";
import { ServerWebSocket, type ServerWebSocketOptions } from "./server.js";

/**
 * The upgrade, as an HTTP exchange: a `GET` with `Upgrade: websocket` goes to
 * an ordinary `(Request) => Response` handler, and a `101` answer carrying a
 * server socket means accepted. Anything else is a refusal, with its status.
 *
 * FORBIDDEN HEADERS. A browser drops `Upgrade`, `Connection` and every
 * `Sec-*` header from a `new Request()`. The upgrade request therefore carries
 * its headers as an own `headers` property, a standalone `Headers` that keeps
 * them, so handler code reads `request.headers.get("upgrade")` as usual.
 *
 * NO 101 IN A `Response`. The constructor refuses statuses below 200, so the
 * response `upgradeWebSocket` returns reports 101 through an own `status`
 * property; the port that goes back to the caller is found with `takePort`.
 */

/** The request header carrying the client's version of the frame protocol. */
export const WS_VERSION_HEADER = "x-webrun-ws-version";

export interface WebSocketUpgradeInit {
  /** Requested subprotocols, in order of preference. */
  protocols?: string[];
  /** More headers for the handler to see (cookies, origin, authorization...). */
  headers?: HeadersInit;
}

/**
 * The `GET` a handler sees for `new WebSocket(url, protocols)`. A `ws:` or
 * `wss:` url is given as `http:` or `https:`, as a server sees it.
 */
export function newWebSocketUpgradeRequest(
  url: string | URL,
  { protocols = [], headers }: WebSocketUpgradeInit = {},
): Request {
  const httpUrl = new URL(`${url}`);
  if (httpUrl.protocol === "ws:") httpUrl.protocol = "http:";
  else if (httpUrl.protocol === "wss:") httpUrl.protocol = "https:";
  const all = new Headers(headers);
  all.set("upgrade", "websocket");
  all.set("connection", "Upgrade");
  all.set("sec-websocket-version", "13");
  if (!all.has("sec-websocket-key")) all.set("sec-websocket-key", randomKey());
  if (protocols.length > 0) all.set("sec-websocket-protocol", protocols.join(", "));
  if (!all.has(WS_VERSION_HEADER)) all.set(WS_VERSION_HEADER, `${WS_PORT_PROTOCOL_VERSION}`);
  return withHeaders(new Request(httpUrl, { method: "GET", headers: all }), all);
}

/**
 * Re-attaches `headers` to `request` as its own `headers` property, keeping
 * the forbidden ones a browser dropped. Returns `request`.
 */
export function withHeaders(request: Request, headers: Headers): Request {
  Object.defineProperty(request, "headers", { value: headers, configurable: true });
  return request;
}

/** Whether `request` asks for a WebSocket. */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** The subprotocols `request` asks for, in order of preference. */
export function requestedProtocols(request: Request): string[] {
  const header = request.headers.get("sec-websocket-protocol");
  if (!header) return [];
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

export interface UpgradeWebSocketOptions extends Omit<ServerWebSocketOptions, "url"> {}

export interface WebSocketUpgrade {
  /** The server end. Call `accept()`, then listen and send. */
  socket: ServerWebSocket;
  /** Return it from the handler: status 101. */
  response: Response;
}

interface PendingUpgrade {
  port: MessagePort;
  protocol: string;
}

/**
 * Where a response from `upgradeWebSocket` keeps its port. A registered
 * symbol, not a module-level `WeakMap`: the handler and the host that takes
 * the port often run different bundles of this package (a page's adapter from
 * `dist/sw.js`, its handler code importing `dist/worker.js`), and each bundle
 * has its own copy of every module.
 */
const UPGRADE = Symbol.for("webrun-http-browser:websocket-upgrade");

/**
 * Accepts a WebSocket upgrade in a handler:
 *
 * ```ts
 * if (isWebSocketUpgrade(request)) {
 *   const { socket, response } = upgradeWebSocket(request, { protocol: "v1" });
 *   socket.accept();
 *   socket.addEventListener("message", (event) => socket.send(event.data));
 *   return response;
 * }
 * ```
 *
 * The host takes the client's port from the response with `takePort` and
 * hands it to the caller.
 */
export function upgradeWebSocket(
  request: Request,
  options: UpgradeWebSocketOptions = {},
): WebSocketUpgrade {
  const protocol = options.protocol ?? "";
  const channel = new MessageChannel();
  const socket = new ServerWebSocket(channel.port1, { ...options, url: request.url, protocol });
  const response = new Response(null, {
    status: 200,
    headers: protocol ? { "sec-websocket-protocol": protocol } : {},
  });
  Object.defineProperties(response, {
    status: { value: 101, configurable: true },
    statusText: { value: "Switching Protocols", configurable: true },
    webSocket: { value: socket, configurable: true },
    [UPGRADE]: { value: { port: channel.port2, protocol }, configurable: true, writable: true },
  });
  return { socket, response };
}

/**
 * The port to hand to the caller, for a response from `upgradeWebSocket`.
 * Taken once: a second call returns `undefined`.
 */
export function takePort(response: Response): MessagePort | undefined {
  return takeUpgrade(response)?.port;
}

/** `takePort`, with the subprotocol the server picked. */
export function takeUpgrade(response: Response): PendingUpgrade | undefined {
  const holder = response as unknown as Record<symbol, PendingUpgrade | undefined>;
  const upgrade = holder[UPGRADE];
  if (upgrade) holder[UPGRADE] = undefined;
  return upgrade;
}

export type WebSocketUpgradeResult =
  | { ok: true; port: MessagePort; protocol: string }
  | { ok: false; status: number; message: string };

export interface ServeWebSocketUpgradeInit extends WebSocketUpgradeInit {
  url: string;
}

/**
 * Runs an upgrade through `handler`, as a host does when a caller asks for a
 * socket: builds the upgrade request, calls the handler, and either takes the
 * port of a `101` or reports the refusal. A subprotocol the caller did not ask
 * for is a refusal, as in the standard.
 */
export async function serveWebSocketUpgrade(
  handler: (request: Request) => Response | Promise<Response>,
  { url, protocols = [], headers }: ServeWebSocketUpgradeInit,
): Promise<WebSocketUpgradeResult> {
  let response: Response;
  try {
    response = await handler(newWebSocketUpgradeRequest(url, { protocols, headers }));
  } catch (error) {
    return { ok: false, status: 500, message: errorMessage(error) };
  }
  const upgrade = takeUpgrade(response);
  if (!upgrade || response.status !== 101) {
    upgrade?.port.close();
    try {
      await response.body?.cancel();
    } catch {}
    return {
      ok: false,
      status: response.status,
      message: `The server refused the upgrade: ${response.status} ${response.statusText}`.trim(),
    };
  }
  if (upgrade.protocol !== "" && !protocols.includes(upgrade.protocol)) {
    upgrade.port.close();
    return {
      ok: false,
      status: 400,
      message: `The server picked the subprotocol '${upgrade.protocol}', which was not requested.`,
    };
  }
  return { ok: true, port: upgrade.port, protocol: upgrade.protocol };
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
