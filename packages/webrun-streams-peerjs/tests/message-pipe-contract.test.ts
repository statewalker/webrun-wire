import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { messageTargetOverPeerJs } from "../src/message-target.js";

/** The slice of a PeerJS `DataConnection` the adapter touches. */
class FakeConn {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  on(ev: string, fn: (...a: unknown[]) => void) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    this.handlers.get(ev)?.delete(fn);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...a);
  }
  serialization = "raw";
  reliable = true;
  open = true;
  bufferSize = 0;
  dataChannel = { bufferedAmount: 0 };
  sent: Uint8Array[] = [];
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }
}

function harness(options?: { maxFrameBytes?: number }): MessagePipeHarness {
  const conn = new FakeConn();
  // biome-ignore lint/suspicious/noExplicitAny: a structural fake
  const pipe = messageTargetOverPeerJs(conn as any, options);
  return {
    pipe,
    inject: (data) => conn.emit("data", data),
    sent: () => conn.sent,
    endRemotely: () => conn.close(),
    setBuffered: (n) => {
      conn.dataChannel.bufferedAmount = n;
    },
  };
}

describeMessagePipe("messageTargetOverPeerJs", () => harness(), {
  withMaxFrameBytes: (maxFrameBytes) => harness({ maxFrameBytes }),
});
