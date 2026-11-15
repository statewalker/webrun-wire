import {
  describeMessagePipe,
  type MessagePipeHarness,
} from "@statewalker/webrun-streams-conformance";
import { DEFAULT_TOPIC, messageTargetOverLiveKit } from "../src/message-target.js";

type Handler = (...a: unknown[]) => void;
/** The slice of a LiveKit `Room` the adapter touches; publishes settle when the test says. */
class FakeRoom {
  private handlers = new Map<string, Set<Handler>>();
  remoteParticipants = new Map([["bob", { identity: "bob" }]]);
  published: Uint8Array[] = [];
  pending: Array<() => void> = [];
  holdPublishes = false;
  localParticipant = {
    publishData: (data: Uint8Array, options: { topic?: string }) => {
      if (options.topic !== DEFAULT_TOPIC) return Promise.resolve();
      this.published.push(data);
      if (!this.holdPublishes) return Promise.resolve();
      return new Promise<void>((resolve) => this.pending.push(resolve));
    },
  };
  on(ev: string, fn: Handler) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)?.add(fn);
  }
  off(ev: string, fn: Handler) {
    this.handlers.get(ev)?.delete(fn);
  }
  emit(ev: string, ...a: unknown[]) {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...a);
  }
}

function harness(options?: { maxFrameBytes?: number }): MessagePipeHarness {
  const room = new FakeRoom();
  // biome-ignore lint/suspicious/noExplicitAny: a structural fake
  const pipe = messageTargetOverLiveKit(room as any, "bob", options);
  return {
    pipe,
    inject: (data) => room.emit("dataReceived", data, { identity: "bob" }, 0, DEFAULT_TOPIC),
    sent: () => room.published,
    endRemotely: () => room.emit("disconnected"),
    // LiveKit's buffered bytes are publishes not yet settled: hold one of the size asked.
    setBuffered: (n) => {
      for (const settle of room.pending.splice(0)) settle();
      if (n === 0) return;
      room.holdPublishes = true;
      pipe.target.postMessage(new Uint8Array(n));
      room.holdPublishes = false;
      // Not part of what the contract sends.
      room.published.pop();
    },
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describeMessagePipe("messageTargetOverLiveKit", () => harness({ maxFrameBytes: 1 << 30 }), {
  withMaxFrameBytes: (maxFrameBytes) => harness({ maxFrameBytes }),
});
