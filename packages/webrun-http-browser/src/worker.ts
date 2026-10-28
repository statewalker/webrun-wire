/**
 * For Dedicated Workers that serve HTTP and WebSockets through the
 * same-origin ServiceWorker: `serveHttpInWorker`, and the WebSocket helpers a
 * handler needs (`upgradeWebSocket`, `isWebSocketUpgrade`...).
 */
export * from "./link/http-link.js";
export type { FetchHandler, HandlerEndpointOptions } from "./sw/handler-endpoint.js";
export * from "./sw/worker-service.js";
export * from "./ws/index.js";
