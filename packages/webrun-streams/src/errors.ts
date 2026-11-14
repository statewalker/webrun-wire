export interface SerializedError {
  message: string;
  stack?: string;
  [key: string]: unknown;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const out: SerializedError = { message: error.message, stack: error.stack };
    const bag = error as unknown as Record<string, unknown>;
    for (const key of Object.keys(bag)) out[key] = bag[key];
    return out;
  }
  if (typeof error === "object" && error !== null) {
    const bag = error as Record<string, unknown>;
    return { message: String(bag.message ?? error), ...bag };
  }
  return { message: String(error) };
}

export function deserializeError(error: SerializedError | string): Error {
  const payload = typeof error === "string" ? { message: error } : error;
  const out = new Error(payload.message) as Error & Record<string, unknown>;
  // Copied key by key: `Object.assign` would run the `__proto__` setter for a peer's own
  // `__proto__` key (msgpack and structured clone both deliver one) and let the peer choose the
  // error's prototype. `constructor` is skipped too, so `err.constructor` stays `Error`.
  for (const key of Object.keys(payload)) {
    if (key === "__proto__" || key === "constructor") continue;
    out[key] = payload[key];
  }
  return out;
}
