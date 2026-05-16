import { deserializeError, type SerializedError } from "@statewalker/webrun-streams";
import { getPortCloseSignal } from "./close-signal.js";

export interface CallPortOptions {
  /** Timeout in ms after which the call rejects (default 1000). */
  timeout?: number;
  /** Channel name filter — peers with a different `channelName` ignore the message. */
  channelName?: string;
  /** Logging function; defaults to a no-op. */
  log?: (...args: unknown[]) => void;
  /** Override the call ID generator (default: `call-<timestamp>-<random>`). */
  newCallId?: () => string;
  /**
   * Optional cancellation signal. Firing it rejects the pending call
   * immediately (without waiting for the timeout) and cleans up the message
   * listener. Use the signal's `reason` for the rejection if present.
   */
  signal?: AbortSignal;
}

type ResponseEnvelope<T> =
  | { type: "response:result"; channelName: string; callId: string; result: T }
  | { type: "response:error"; channelName: string; callId: string; error: SerializedError };

/**
 * Asynchronous request/response over a `MessagePort`.
 *
 * Sends `params` to the peer listening with `listenPort`, waits up to
 * `timeout` ms for a matching reply, and either resolves with the result or
 * rejects with the deserialised error.
 */
export function callPort<TResult = unknown, TParams = unknown>(
  port: MessagePort,
  params: TParams,
  {
    timeout = 1000,
    channelName = "",
    log = () => {},
    newCallId = () => `call-${Date.now()}-${String(Math.random()).substring(2)}`,
    signal,
  }: CallPortOptions = {},
): Promise<TResult> {
  const callId = newCallId();
  log("[callPort]", { channelName, callId, params });
  // Combine the caller's signal (if any) with the port's transport-close
  // signal (if the port is transport-backed). Either firing rejects the
  // pending call. Without this, `callPort` would hang on transport-level
  // disconnects until the per-call `timeout` fires (default 1 s, but
  // higher-level operations like httpFetch dial it up to ~24 days).
  const portCloseSignal = getPortCloseSignal(port);
  const combinedSignal = combineSignals(signal, portCloseSignal);
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let onMessage: ((event: MessageEvent) => void) | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<TResult>((resolve, reject) => {
    if (combinedSignal?.aborted) {
      reject(abortReason(combinedSignal));
      return;
    }
    timerId = setTimeout(() => reject(new Error(`Call timeout. CallId: "${callId}".`)), timeout);
    onMessage = (event: MessageEvent) => {
      const data = event.data as ResponseEnvelope<TResult> | undefined;
      if (!data) return;
      if (data.channelName !== channelName) return;
      if (data.callId !== callId) return;
      if (data.type === "response:error") reject(deserializeError(data.error));
      else if (data.type === "response:result") resolve(data.result);
    };
    port.addEventListener("message", onMessage);
    if (combinedSignal) {
      onAbort = () => reject(abortReason(combinedSignal));
      combinedSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // Swallow rejection on this side-branch so the cleanup .finally doesn't
  // surface an unhandled rejection. The original `promise` keeps its
  // rejection for the caller.
  promise
    .catch(() => {})
    .finally(() => {
      if (timerId !== undefined) clearTimeout(timerId);
      if (onMessage) port.removeEventListener("message", onMessage);
      if (onAbort && combinedSignal) combinedSignal.removeEventListener("abort", onAbort);
    });
  port.postMessage({ type: "request", channelName, callId, params });
  return promise;
}

function abortReason(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined ? "Aborted" : String(reason));
  err.name = "AbortError";
  return err;
}

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  // `AbortSignal.any` (ES2024) forwards `aborted` + `reason` from the first
  // input that fires and auto-cleans up its listeners when the result is GC'd.
  return AbortSignal.any(live);
}
