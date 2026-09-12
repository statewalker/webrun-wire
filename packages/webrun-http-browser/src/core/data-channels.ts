import {
  deserializeError,
  recieveIterator,
  type SerializedError,
  sendIterator,
  serializeError,
} from "@statewalker/webrun-streams";
import type { MessageTarget } from "./message-target.js";

const MESSAGE_TYPE_REQUEST = "REQUEST";
const MESSAGE_TYPE_RESPONSE = "RESPONSE";

type InvocationMessage =
  | { type: typeof MESSAGE_TYPE_REQUEST; callId: number; request: unknown }
  | {
      type: typeof MESSAGE_TYPE_RESPONSE;
      callId: number;
      response?: unknown;
      error?: SerializedError;
    };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

let __invocationCounter = 0;

export interface InvocationChannel {
  start(): Promise<void>;
  close(): Promise<void>;
  invoke<T = unknown>(request?: unknown, ...transfers: Transferable[]): Promise<T>;
}

export interface NewInvocationChannelOptions {
  port: MessageTarget;
  handler?: (request: unknown, ...ports: MessagePort[]) => unknown;
  onError?: (error: unknown) => void;
  newCallId?: () => number;
}

export function newInvokationChannel({
  port,
  handler = () => {
    throw new Error("Handler not implemented");
  },
  onError = console.error,
  newCallId = () => ++__invocationCounter,
}: NewInvocationChannelOptions): InvocationChannel {
  const requests: Record<number, PendingRequest> = {};

  const listener = async (event: MessageEvent) => {
    const data = (event.data ?? {}) as InvocationMessage;
    if (data.type === MESSAGE_TYPE_REQUEST) {
      try {
        const result = await handler(data.request, ...(event.ports as MessagePort[]));
        const [response, ...transfers] = Array.isArray(result)
          ? (result as unknown[])
          : result !== undefined
            ? [result]
            : [];
        port.postMessage(
          { type: MESSAGE_TYPE_RESPONSE, callId: data.callId, response },
          transfers as Transferable[],
        );
      } catch (error) {
        port.postMessage({
          type: MESSAGE_TYPE_RESPONSE,
          callId: data.callId,
          error: serializeError(error),
        });
      }
    } else if (data.type === MESSAGE_TYPE_RESPONSE) {
      const pending = requests[data.callId];
      delete requests[data.callId];
      if (!pending) return;
      if (data.error) pending.reject(deserializeError(data.error));
      else pending.resolve(data.response);
    }
  };

  const start = async () => {
    try {
      port.addEventListener("message", listener);
      await port.start?.();
    } catch (e) {
      onError(e);
    }
  };

  const close = async () => {
    try {
      port.removeEventListener("message", listener);
      await port.close?.();
    } catch (e) {
      onError(e);
    }
  };

  const invoke = <T>(request: unknown = {}, ...transfers: Transferable[]): Promise<T> => {
    const callId = newCallId();
    return new Promise<T>((resolve, reject) => {
      try {
        requests[callId] = {
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        port.postMessage({ type: MESSAGE_TYPE_REQUEST, callId, request }, transfers);
      } catch (error) {
        delete requests[callId];
        reject(error);
      }
    });
  };

  return { start, close, invoke };
}

export async function* sendStream<T>(
  communicationPort: MessageTarget,
  input: AsyncIterable<T>,
  params: Record<string, unknown> = {},
): AsyncGenerator<T, void, unknown> {
  const messageChannel = new MessageChannel();
  communicationPort.postMessage({ type: "START_CALL", params }, [messageChannel.port2]);

  const channel = newStreamChannel<T>(messageChannel.port1);
  let drained = false;
  try {
    await channel.start();
    void channel.sendAll(input);
    yield* channel.recieveAll();
    drained = true;
  } finally {
    // A caller that stops early — an aborted `fetch`, a cancelled response
    // body, a `break` — has to TELL the peer. Closing a `MessagePort` does not
    // notify the other end, so without this the handler on the far side keeps
    // producing into a port nobody reads, for the life of the page.
    if (!drained) channel.cancel();
    await channel.close();
  }
}

export type StreamHandler<T> = (
  input: AsyncIterable<T>,
  params: Record<string, unknown>,
) => AsyncIterable<T> | Promise<AsyncIterable<T>>;

export function handleStreams<T>(
  communicationPort: MessageTarget,
  handler: StreamHandler<T>,
): () => void {
  const listener = async (event: MessageEvent) => {
    const { type, params } = (event.data ?? {}) as {
      type?: string;
      params?: Record<string, unknown>;
    };
    if (type !== "START_CALL") return;
    const port = event.ports[0];
    const channel = newStreamChannel<T>(port);
    try {
      await channel.start();
      const input = channel.recieveAll();
      const response = await handler(input, params ?? {});
      await channel.sendAll(response);
    } finally {
      await channel.close();
    }
  };
  communicationPort.addEventListener("message", listener);
  communicationPort.start?.();
  return () => communicationPort.removeEventListener("message", listener);
}

interface StreamChannel<T> {
  start(): Promise<void>;
  close(): Promise<void>;
  /** Tell the peer we have stopped reading, so it can release its producer. */
  cancel(): void;
  recieveAll(): AsyncGenerator<T, void, unknown>;
  sendAll(it: AsyncIterable<T>): Promise<void>;
}

/** A data chunk, or — with `cancel` — the peer saying it has stopped reading. */
type StreamMessage<T> = { done?: boolean; value?: T; error?: unknown; cancel?: boolean };

function newStreamChannel<T>(port: MessageTarget): StreamChannel<T> {
  type DataListener = (msg: StreamMessage<T>) => Promise<boolean>;
  let listeners: DataListener[] = [];
  let iterators: AsyncIterable<T>[] = [];

  const notifyAll = async (data: StreamMessage<T>) => {
    for (const listener of listeners) await listener(data);
  };

  /**
   * Release whatever we are sending. NOT awaited: `.return()` on an async
   * generator parked awaiting its own source is queued behind that pending
   * `next()`, so awaiting it here would block the message handler — and the
   * chunk that would unblock it can only arrive through that same handler.
   */
  const cancelOutgoing = (): void => {
    for (const it of [...iterators]) {
      const iterable = it as AsyncIterable<T> & { return?: () => unknown };
      void Promise.resolve(iterable.return?.()).catch(() => {});
    }
  };

  const channel = newInvokationChannel({
    port,
    handler: (data: unknown) => {
      const message = data as StreamMessage<T>;
      if (message?.cancel) {
        cancelOutgoing();
        return;
      }
      return notifyAll(message);
    },
  });

  const start = () => channel.start();

  const cancel = (): void => {
    // Best effort by design: the port may already be gone, and a peer that
    // never hears this is no worse off than before the message existed.
    void channel.invoke({ cancel: true }).catch(() => {});
  };

  const close = async () => {
    await notifyAll({ done: true });
    for (const it of [...iterators]) {
      const iterable = it as AsyncIterable<T> & { return?: () => unknown };
      await iterable.return?.();
    }
    await channel.close();
  };

  async function* recieveAll(): AsyncGenerator<T, void, unknown> {
    yield* recieveIterator<T>((deliver) => {
      listeners.push(deliver as DataListener);
      return () => {
        listeners = listeners.filter((l) => l !== deliver);
      };
    });
  }

  async function sendAll(it: AsyncIterable<T>): Promise<void> {
    await sendIterator<T>(
      (chunk) => void channel.invoke(chunk),
      (async function* () {
        try {
          iterators.push(it);
          yield* it;
        } finally {
          iterators = iterators.filter((i) => i !== it);
        }
      })(),
    );
  }

  return { start, close, cancel, recieveAll, sendAll };
}
