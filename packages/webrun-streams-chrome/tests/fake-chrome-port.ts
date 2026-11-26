import type { ChromeEventLike, ChromePortLike } from "../src/index.js";

class FakeEvent<L extends (...args: never[]) => unknown> implements ChromeEventLike<L> {
  readonly listeners = new Set<L>();
  addListener(listener: L): void {
    this.listeners.add(listener);
  }
  removeListener(listener: L): void {
    this.listeners.delete(listener);
  }
  emit(...args: Parameters<L>): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

/**
 * One end of a fake `chrome.runtime.Port` pair. As Chrome does, it carries
 * messages as JSON, delivers them asynchronously and in order, throws on a
 * post once disconnected, and fires `onDisconnect` on the other end only.
 */
export class FakeChromePort implements ChromePortLike {
  readonly onMessage = new FakeEvent<(message: unknown, port: ChromePortLike) => void>();
  readonly onDisconnect = new FakeEvent<(port: ChromePortLike) => void>();
  /** Every message this end posted, as JSON text. */
  readonly posted: string[] = [];
  peer?: FakeChromePort;
  connected = true;

  constructor(readonly name = "") {}

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object");
    const json = JSON.stringify(message);
    this.posted.push(json);
    const peer = this.peer;
    setTimeout(() => {
      if (peer?.connected) peer.onMessage.emit(JSON.parse(json), peer);
    }, 0);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer;
    setTimeout(() => peer?.dropFromPeer(), 0);
  }

  /** The other end went away (a disconnect, a service worker stopped). */
  dropFromPeer(): void {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect.emit(this);
  }

  /** A message as Chrome would hand it to this end's listeners. */
  receive(message: unknown): void {
    this.onMessage.emit(JSON.parse(JSON.stringify(message)), this);
  }
}

/** Two connected ends, as `chrome.runtime.connect` and `runtime.onConnect` give them. */
export function fakeChromePortPair(name = "webrun"): [FakeChromePort, FakeChromePort] {
  const a = new FakeChromePort(name);
  const b = new FakeChromePort(name);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
