export type MessageListener = (event: MessageEvent) => void | Promise<void>;

/** An object we can listen for `"message"` events on. */
export interface MessageSource {
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  start?(): void | Promise<void>;
}

/** An object we can post messages to (with optional transferable list). */
export interface MessageSink {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** Full-duplex message target: both sends and receives. */
export interface MessageTarget extends MessageSource, MessageSink {
  /** `reason`, where the target keeps one, becomes its close signal's reason. */
  close?(reason?: unknown): void | Promise<void>;
}
