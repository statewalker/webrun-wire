import { callPort } from "./call-port.js";
import { listenPort } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";

/** The method names of `T` whose values are functions. */
export type MethodNames<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
  string;

export interface ServeMethodsOptions<T> {
  /** The channel both ends agree on; calls on other channels are ignored. */
  channelName: string;
  /** The methods served. A call to any other name is refused. */
  methods: readonly MethodNames<T>[];
  /**
   * Longest a method may run, in ms; past it the caller gets an `ETIMEDOUT`
   * error (the method itself is not stopped). Unset: no deadline.
   */
  timeout?: number;
}

export interface MethodsClientOptions<T> {
  /** The channel both ends agree on. */
  channelName: string;
  /** The methods the client gets. */
  methods: readonly MethodNames<T>[];
  /**
   * Longest a call waits for its answer, in ms (default
   * {@link DEFAULT_METHODS_TIMEOUT}). `NO_TIMEOUT` waits until the answer, an
   * abort, or the port's close signal.
   */
  timeout?: number;
}

/** 30 s: a call's default deadline in {@link methodsClient}. */
export const DEFAULT_METHODS_TIMEOUT = 30_000;

/** One call on the wire: a method name and its arguments. */
interface MethodCall {
  method: string;
  args: unknown[];
}

/**
 * Serves `impl`'s `methods` on `port`, answering {@link methodsClient}.
 * Returns the teardown.
 */
export function serveMethods<T extends object>(
  port: MessageTarget,
  impl: T,
  { channelName, methods, timeout }: ServeMethodsOptions<T>,
): () => void {
  // Only names in this set are ever looked up on `impl`, so a caller cannot reach
  // `constructor`, `__proto__` or any method the server did not list.
  const served = new Set<string>(methods);
  return listenPort<MethodCall>(
    port,
    async (call) => {
      const method = call?.method;
      const args = call?.args;
      if (typeof method !== "string" || !served.has(method)) {
        throw refusal("ENOSYS", `no method '${String(method)}'`);
      }
      const fn = (impl as Record<string, unknown>)[method];
      if (typeof fn !== "function") throw refusal("ENOSYS", `no method '${method}'`);
      if (!Array.isArray(args))
        throw refusal("EINVAL", `the arguments of '${method}' are not an array`);
      try {
        return await withDeadline(Promise.resolve(fn.apply(impl, args)), timeout, method);
      } catch (error) {
        throw toWireError(error);
      }
    },
    { channelName },
  );
}

function withDeadline<R>(run: Promise<R>, timeout: number | undefined, method: string): Promise<R> {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) return run;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(refusal("ETIMEDOUT", `'${method}' ran past ${timeout} ms`)),
      timeout,
    );
  });
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
}

/** A refusal as it crosses the wire: a message and a code, no stack. */
function refusal(code: string, message: string): WireError {
  return { name: "Error", message, code };
}

/**
 * What of a thrown value the caller sees: its name, message and `code`. The
 * stack and any other properties stay on the server, where they may name
 * paths, hosts or secrets the caller has no business with.
 */
function toWireError(error: unknown): WireError {
  if (typeof error !== "object" || error === null) return { name: "Error", message: String(error) };
  const bag = error as { name?: unknown; message?: unknown; code?: unknown };
  const out: WireError = {
    name: typeof bag.name === "string" ? bag.name : "Error",
    message: typeof bag.message === "string" ? bag.message : String(error),
  };
  if (typeof bag.code === "string" || typeof bag.code === "number") out.code = bag.code;
  return out;
}

interface WireError {
  name: string;
  message: string;
  code?: string | number;
}

/** A client for the methods {@link serveMethods} serves on `port`. */
export function methodsClient<T extends object>(
  port: MessageTarget,
  { channelName, methods, timeout = DEFAULT_METHODS_TIMEOUT }: MethodsClientOptions<T>,
): Pick<T, MethodNames<T>> {
  const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods) {
    client[method] = (...args) =>
      callPort<unknown, MethodCall>(port, { method, args }, { channelName, timeout });
  }
  return client as unknown as Pick<T, MethodNames<T>>;
}
