/** An event of a `chrome.runtime.Port`: listeners added and removed. */
export interface ChromeEventLike<L extends (...args: never[]) => unknown> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

/**
 * The slice of a `chrome.runtime.Port` the pipe touches, so the package needs
 * no `@types/chrome` and tests can pass a fake. A real port satisfies it.
 */
export interface ChromePortLike {
  /** The name given to `chrome.runtime.connect({ name })`. */
  readonly name?: string;
  /** Sends one JSON-serialisable message; throws once the port is disconnected. */
  postMessage(message: unknown): void;
  /** Disconnects the port; the other end's `onDisconnect` fires. */
  disconnect(): void;
  readonly onMessage: ChromeEventLike<(message: unknown, port: ChromePortLike) => void>;
  readonly onDisconnect: ChromeEventLike<(port: ChromePortLike) => void>;
}
