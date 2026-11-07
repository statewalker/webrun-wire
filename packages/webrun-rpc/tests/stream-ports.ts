import { type MessageTarget, multiplexPort, structuredCodec } from "../src/index.js";

/** The window the windowed variants of the stream suites run with. */
export const STREAM_WINDOW = 64 * 1024;

/** The two ends of one stream port; `port1` is the caller's. */
export interface StreamPorts {
  port1: MessageTarget & { close(): void | Promise<void> };
  port2: MessageTarget & { close(): void | Promise<void> };
}

/**
 * Both ends of one stream port, for the suites that run with and without a
 * window: a `MessageChannel`'s two ports, or one port of two windowed
 * multiplexers over it. A windowed pair is returned only once both ends agreed
 * `pipeline` and `end` — the ack listed both, and the opener answered it — so
 * a test runs with everything the window brings in force. What closes it goes
 * to `cleanups`.
 */
export async function streamPorts(
  windowed: boolean,
  cleanups: Array<() => void>,
): Promise<StreamPorts> {
  const ch = new MessageChannel();
  ch.port1.start();
  ch.port2.start();
  cleanups.push(() => {
    ch.port1.close();
    ch.port2.close();
  });
  if (!windowed) return ch;

  let accepted: (port: MessageTarget) => void = () => {};
  const served = new Promise<MessageTarget>((resolve) => {
    accepted = resolve;
  });
  // Read off the raw pipe: the responder's ack, then the opener's answer to it.
  // The answer is the opener's first credit, and it is zero bytes.
  let ackCaps: unknown;
  const acked = new Promise<void>((resolve) => {
    ch.port1.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "credit" && envelope.caps && ackCaps === undefined) {
        ackCaps = envelope.caps;
        resolve();
      }
    });
  });
  let answer: unknown;
  const answered = new Promise<void>((resolve) => {
    ch.port2.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "credit" && answer === undefined) {
        answer = envelope.bytes;
        resolve();
      }
    });
  });
  const server = multiplexPort(ch.port2, {
    codec: structuredCodec,
    side: "responder",
    window: STREAM_WINDOW,
    onPort: (port) => {
      accepted(port);
    },
  });
  const client = multiplexPort(ch.port1, {
    codec: structuredCodec,
    side: "initiator",
    window: STREAM_WINDOW,
  });
  cleanups.push(() => {
    void client.close();
    void server.close();
  });
  const port1 = await client.openPort({ kind: "stream" });
  const port2 = await served;
  await Promise.all([acked, answered]);
  if (JSON.stringify(ackCaps) !== JSON.stringify(["pipeline", "end"]) || answer !== 0) {
    throw new Error(`the ack agreed ${JSON.stringify(ackCaps)}, answered by ${answer}`);
  }
  return {
    port1: port1 as StreamPorts["port1"],
    port2: port2 as StreamPorts["port2"],
  };
}
