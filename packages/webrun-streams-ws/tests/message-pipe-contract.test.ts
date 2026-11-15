import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { messageTargetOverWebSocket } from "../src/message-target.js";
import type { WebSocketLike } from "../src/websocket-like.js";

/** The slice of a WebSocket the adapter touches, with handles to drive it. */
class FakeWs {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  private listeners = new Map<string, Set<(e?: unknown) => void>>();
  addEventListener(type: string, fn: (e?: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, event?: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }
}

function harness(options?: { maxFrameBytes?: number }): MessagePipeHarness {
  const ws = new FakeWs();
  const pipe = messageTargetOverWebSocket(ws as unknown as WebSocketLike, options);
  return {
    pipe,
    inject: (data) => ws.emit("message", new MessageEvent("message", { data })),
    sent: () => ws.sent,
    endRemotely: () => ws.close(),
    setBuffered: (n) => {
      ws.bufferedAmount = n;
    },
  };
}

describeMessagePipe("messageTargetOverWebSocket", () => harness(), {
  withMaxFrameBytes: (maxFrameBytes) => harness({ maxFrameBytes }),
});
