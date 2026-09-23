import { type BrokerOptions, newBroker } from "./broker.js";
import { formatSseEvent } from "./sse.js";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface PubSub {
  handler: FetchHandler;
  publish(topic: string, data: unknown, event?: string): void;
  subscriberCount(topic: string): number;
}

/** The topic is the final non-empty path segment: /_events/build -> "build". */
function topicOf(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

export function newPubSub(options: BrokerOptions = {}): PubSub {
  const broker = newBroker(options);

  const handler: FetchHandler = async (request) => {
    const topic = topicOf(request);
    const header = request.headers.get("last-event-id");
    const lastEventId = header === null ? undefined : Number(header);

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: string) => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // The client went away between our check and the enqueue.
            unsubscribe?.();
          }
        };

        if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
          const { events, complete } = broker.replay(topic, lastEventId);
          // Tell the client its history is incomplete rather than handing it a
          // partial replay that looks whole; it can reload instead of patching.
          if (!complete) send(formatSseEvent({ id: lastEventId, event: "gap", data: { from: lastEventId } }));
          for (const e of events) send(formatSseEvent(e));
        }

        unsubscribe = broker.subscribe(topic, (e) => send(formatSseEvent(e)));
      },
      cancel() {
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no", // defeat proxy buffering that would stall delivery
      },
    });
  };

  return {
    handler,
    publish: (topic, data, event) => void broker.publish(topic, data, event),
    subscriberCount: (topic) => broker.subscriberCount(topic),
  };
}
