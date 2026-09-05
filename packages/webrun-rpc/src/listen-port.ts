import { serializeError } from "@statewalker/webrun-streams";

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
  port: MessagePort,
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
    port.postMessage({ callId, channelName, type, result, error });
  };
  port.addEventListener("message", onMessage);
  return () => port.removeEventListener("message", onMessage);
}
