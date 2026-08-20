/**
 * A `Request` stand-in for a runtime without request body streams, and the
 * switch that installs it globally for the duration of a test.
 *
 * Shared by every suite that exercises the fallbacks in `fetch.ts` and
 * `http-stubs.ts`: those four call sites must agree about what the platform
 * gap looks like, so there is one description of it here rather than one per
 * test file.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Faithful on both counts that matter: the class defines no `body` accessor
 * anywhere on its prototype, and its constructor treats anything that is
 * neither a string nor a `BufferSource` as a `USVString` — which is precisely
 * how a `ReadableStream` ends up stored as the text `[object ReadableStream]`
 * in Firefox.
 */
export class NoStreamsRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly signal: AbortSignal | undefined;
  readonly #bytes: Uint8Array;

  constructor(input: string, init: RequestInit = {}) {
    this.url = input;
    this.method = init.method ?? "GET";
    this.headers = new Headers(init.headers);
    this.signal = init.signal ?? undefined;
    this.#bytes = NoStreamsRequest.#toBytes(init.body);
  }

  static #toBytes(body: BodyInit | null | undefined): Uint8Array {
    if (body == null) return new Uint8Array(0);
    if (typeof body === "string") return encoder.encode(body);
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return encoder.encode(String(body));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return decoder.decode(this.#bytes);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

/**
 * Swap the global `Request` for the Firefox-shaped one. Call the result to undo.
 *
 * Models one runtime shape only — both halves absent at once. It structurally
 * cannot express the split Safari has (a readable `Request.body`, but no
 * `ReadableStream` accepted as `init.body`), because installing this class
 * removes the accessor and the constructor support together. If that case ever
 * needs covering it wants a second stand-in, not a flag on this one; see the
 * note on `supportsRequestStreams` in `src/request-streams.ts`.
 */
export function withoutRequestStreams(): () => void {
  const original = globalThis.Request;
  const install = (value: unknown): void => {
    Object.defineProperty(globalThis, "Request", {
      configurable: true,
      writable: true,
      value,
    });
  };
  install(NoStreamsRequest);
  return () => install(original);
}
