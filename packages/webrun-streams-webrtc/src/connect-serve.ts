import type { Connect, Duplex, Serve } from "@statewalker/webrun-streams";
import { duplexOverDataChannel } from "./duplex-over-data-channel.js";

export interface WebRtcParams {
  /** Open `RTCPeerConnection`. Signalling, auth, and connection setup are the caller's responsibility. */
  pc: RTCPeerConnection;
}

/**
 * Caller-side: each `call(input)` invocation opens a new `RTCDataChannel` on
 * `pc` and runs the call over it. The DataChannel's `label` is generated
 * locally and the responder picks the channel up via `pc.ondatachannel`.
 */
export const connect: Connect<WebRtcParams> = async ({ pc }) => {
  let counter = 0;
  let closed = false;
  const open = new Set<RTCDataChannel>();
  const onConnectionClose = (): void => {
    closed = true;
  };
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "closed" || pc.connectionState === "failed") onConnectionClose();
  });

  const call: Duplex = (input) => {
    if (closed) {
      return (async function* () {
        if ((0 as number) === 0) throw new Error("webrun-streams-webrtc: connection closed");
        yield new Uint8Array(0);
      })();
    }
    const label = `webrun/${Date.now().toString(36)}/${(counter++).toString(36)}`;
    const dc = pc.createDataChannel(label);
    open.add(dc);
    dc.addEventListener("close", () => open.delete(dc));
    return (async function* () {
      await waitForOpen(dc);
      yield* duplexOverDataChannel(dc, toAsyncIterable(input));
    })();
  };

  return {
    call,
    async close() {
      closed = true;
      for (const dc of open) {
        try {
          dc.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
};

/**
 * Server-side: registers `pc.ondatachannel` and routes each inbound channel
 * to `handler`. Returns a teardown that stops accepting new channels;
 * channels already in flight continue until their `Duplex` completes.
 */
export const serve: Serve<WebRtcParams> = async ({ pc }, handler: Duplex) => {
  const onChannel = (ev: RTCDataChannelEvent): void => {
    const dc = ev.channel;
    void (async () => {
      await waitForOpen(dc);
      const inputFromPeer = peekInput(dc);
      const out = handler(inputFromPeer.input);
      for await (const chunk of duplexOverDataChannel(dc, out)) {
        inputFromPeer.deliver(chunk);
      }
      inputFromPeer.done();
    })();
  };
  pc.addEventListener("datachannel", onChannel);
  let torn = false;
  return async () => {
    if (torn) return;
    torn = true;
    pc.removeEventListener("datachannel", onChannel);
  };
};

function waitForOpen(dc: RTCDataChannel): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      dc.removeEventListener("open", onOpen);
      dc.removeEventListener("close", onClose);
      dc.removeEventListener("error", onError);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("DataChannel closed before open"));
    };
    const onError = (ev: Event): void => {
      cleanup();
      reject(
        new Error(
          `DataChannel error: ${(ev as unknown as { error?: { message?: string } }).error?.message ?? "unknown"}`,
        ),
      );
    };
    dc.addEventListener("open", onOpen);
    dc.addEventListener("close", onClose);
    dc.addEventListener("error", onError);
  });
}

function toAsyncIterable(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if ((input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]) {
    return input as AsyncIterable<Uint8Array>;
  }
  const it = (input as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve(it.next()),
      };
    },
  };
}

interface PeekInput {
  input: AsyncGenerator<Uint8Array>;
  deliver(chunk: Uint8Array): void;
  done(): void;
}

/**
 * For the server side, the handler needs an `input` async iterable backed by
 * the peer's bytes — which arrive via `duplexOverDataChannel`'s yields on this
 * very `dc`. This helper builds a queue/iterator pair so the handler reads
 * from `input` while we drive `duplexOverDataChannel` and tee chunks into it.
 *
 * The arrangement: `duplexOverDataChannel(dc, handlerOutput)` returns the
 * inbound stream as its own AsyncGenerator. We `deliver()` each chunk into
 * the handler's input queue.
 */
function peekInput(_dc: RTCDataChannel): PeekInput {
  const slots: Array<{ type: "value"; value: Uint8Array } | { type: "done" }> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const input = (async function* () {
    try {
      while (true) {
        if (slots.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
          continue;
        }
        const slot = slots.shift();
        if (!slot) continue;
        if (slot.type === "done") return;
        yield slot.value;
      }
    } finally {
      closed = true;
    }
  })();
  return {
    input,
    deliver(chunk: Uint8Array): void {
      if (closed) return;
      slots.push({ type: "value", value: chunk });
      wake?.();
    },
    done(): void {
      if (closed) return;
      slots.push({ type: "done" });
      wake?.();
    },
  };
}
