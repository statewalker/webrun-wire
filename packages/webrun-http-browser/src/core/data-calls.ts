import { deserializeError, serializeError } from "@statewalker/webrun-streams";
import type { MessageSink, MessageSource } from "./message-target.js";

export type ChannelCallHandler = (
  event: MessageEvent,
  params: unknown,
  ...transfers: MessagePort[]
) => unknown;

const TRANSFER = Symbol.for("webrun-http-browser:transfer");

interface TransferResult {
  [TRANSFER]: true;
  value: unknown;
  transfer: Transferable[];
}

/**
 * A channel call's result that carries transferables, a `MessagePort` say:
 * return `withTransfer({ port }, [port])` from a `handleChannelCalls` handler
 * and `callChannel` resolves with `{ port }`.
 */
export function withTransfer<T>(value: T, transfer: Transferable[]): T {
  return { [TRANSFER]: true, value, transfer } as unknown as T;
}

function isTransferResult(value: unknown): value is TransferResult {
  return typeof value === "object" && value !== null && TRANSFER in value;
}

/** Splits a handler's result into the value to post and its transfer list. */
export function unwrapTransfer(result: unknown): { value: unknown; transfer: Transferable[] } {
  return isTransferResult(result)
    ? { value: result.value, transfer: result.transfer }
    : { value: result, transfer: [] };
}

export function callChannel<T = unknown>(
  target: MessageSink,
  callType: string,
  params: unknown,
  ...transfers: Transferable[]
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev: MessageEvent) => {
      const { result, error } = ev.data as { result?: T; error?: unknown };
      if (error) reject(deserializeError(error as never));
      else resolve(result as T);
    };
    target.postMessage({ type: callType, params }, [channel.port2, ...transfers]);
  });
}

export function handleChannelCalls(
  target: MessageSource,
  callType: string,
  handler: ChannelCallHandler,
): () => void {
  const listener = async (event: MessageEvent) => {
    if (!event.data || event.data.type !== callType) return;
    const [port, ...transfers] = event.ports ?? [];
    const response: { result?: unknown; error?: unknown } = {};
    let transfer: Transferable[] = [];
    try {
      const result = await handler(event, event.data.params, ...transfers);
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
