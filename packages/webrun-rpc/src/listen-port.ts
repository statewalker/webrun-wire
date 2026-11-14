import { serializeError } from "@statewalker/webrun-streams";
import type { MessageTarget } from "./message-target.js";

export interface ListenPortOptions {
  /** Channel name filter — ignore messages whose `channelName` doesn't match. */
  channelName?: string;
  /** Logging function; defaults to a no-op. */
  log?: (...args: unknown[]) => void;
}

export type PortHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
) => TResult | Promise<TResult>;

/**
 * Installs `handler` as the server side of a `callPort` / `listenPort`
 * request/response pair on `port`.
 *
 * Returns a cleanup function that removes the listener.
 */
export function listenPort<TParams = unknown, TResult = unknown>(
  port: MessageTarget,
  handler: PortHandler<TParams, TResult>,
  { channelName = "", log = () => {} }: ListenPortOptions = {},
): () => void {
  const onMessage = async (event: MessageEvent) => {
    const data = event.data as
      | { type: string; channelName: string; callId: string; params: TParams }
      | undefined;
    if (!data || data.channelName !== channelName || data.type !== "request") return;
    const { callId, params } = data;
    log("[listenPort]", { channelName, callId, params });
    let result: TResult | undefined;
    let error: ReturnType<typeof serializeError> | undefined;
    let type: "response:result" | "response:error";
    try {
      result = await handler(params);
      type = "response:result";
    } catch (e) {
      error = serializeError(e);
      type = "response:error";
    }
    try {
      port.postMessage({ callId, channelName, type, result, error });
    } catch (e) {
      // The reply could not be posted (an unclonable result or error field, or
      // a codec that cannot serialise it). Tell the caller why, with the
      // message only, rather than leave it waiting for its timeout.
      try {
        const message = e instanceof Error ? e.message : String(e);
        port.postMessage({
          callId,
          channelName,
          type: "response:error",
          error: serializeError(new Error(`webrun-rpc: the reply could not be sent: ${message}`)),
        });
      } catch {
        /* the port itself is unusable; nothing more can reach the caller */
      }
    }
  };
  // A request counts as consumed (for a port's window) once it is handed to its
  // handler, not when the handler finishes: a handler that waits for a later
  // call on the same port (long polls, subscriptions) must not hold the window
  // that later call needs.
  const listener = (event: MessageEvent): void => {
    void onMessage(event);
  };
  port.addEventListener("message", listener);
  return () => port.removeEventListener("message", listener);
}
