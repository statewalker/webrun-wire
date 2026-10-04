import { type Broker, type BrokerOptions, newBroker, type Unsubscribe } from "./broker.js";
import { formatSseEvent } from "./sse.js";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface PubSubOptions extends BrokerOptions {
  /**
   * When given, only these topic names are served; anything else answers 404.
   * Without it any request path allocates a topic, so an open endpoint should
   * set this.
   */
  topics?: readonly string[];
  /**
   * Interval in ms for `: ping` comment frames, which the SSE parser ignores but
   * which keep a half-open connection visible to proxies. 0 (the default) means
   * no heartbeat: a connection that dies silently is then only noticed when the
   * client's own reconnect timer fires.
   */
  heartbeatMs?: number;
}

export interface PubSub {
  handler: FetchHandler;
  publish(topic: string, data: unknown, event?: string): void;
  subscriberCount(topic: string): number;
  /** How many topics currently hold state; a topic with no subscribers and no retained events is dropped. */
  topicCount(): number;
}

/** The topic is the final non-empty path segment: /_events/build -> "build". */
function topicOf(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  return segments.at(-1) ?? "";
}

export interface SseSourceOptions {
  /** Replay events after this id; undefined for a fresh subscription. */
  replayFrom?: number;
  /** Send a `gap` before anything else — the client's Last-Event-ID was unusable. */
  forceGap?: boolean;
  /** See {@link PubSubOptions.heartbeatMs}. */
  heartbeatMs?: number;
}

/**
 * The `ReadableStream` source behind one subscription.
 *
 * Exported so tests can drive it with a controller whose `enqueue` fails, which
 * is the one path a real stream cannot be pushed down from outside.
 */
export function createSseSource(
  broker: Broker,
  topic: string,
  { replayFrom, forceGap = false, heartbeatMs = 0 }: SseSourceOptions = {},
): UnderlyingSource<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: Unsubscribe | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let broken = false;

  return {
    start(controller) {
      /** Tear the subscription down and end the stream, once. */
      const stop = () => {
        if (broken) return;
        broken = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = undefined;
        try {
          controller.close();
        } catch {
          // Already closed or errored; nothing left to do.
        }
      };

      const write = (frame: () => string) => {
        if (broken) return;
        try {
          // Formatting happens inside the guard: it is given caller data, and a
          // throw here used to escape this catch entirely.
          controller.enqueue(encoder.encode(frame()));
        } catch {
          // The client went away, or the frame could not be produced.
          stop();
        }
      };

      // Subscribe first, so the teardown above can release it even if the very
      // first replay frame fails.
      unsubscribe = broker.subscribe(topic, (e) => write(() => formatSseEvent(e)));

      if (forceGap || replayFrom !== undefined) {
        const from = replayFrom ?? 0;
        const { events, complete } =
          replayFrom === undefined
            ? { events: [], complete: false }
            : broker.replay(topic, replayFrom);
        // Tell the client its history is incomplete rather than handing it a
        // partial replay that looks whole; it can reload instead of patching.
        if (!complete) write(() => formatSseEvent({ id: from, event: "gap", data: { from } }));
        for (const e of events) write(() => formatSseEvent(e));
      }

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => write(() => ": ping\n\n"), heartbeatMs);
      }
    },

    cancel() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      broken = true;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

export function newPubSub(options: PubSubOptions = {}): PubSub {
  const { topics, heartbeatMs, ...brokerOptions } = options;
  const broker = newBroker(brokerOptions);
  const allowed = topics === undefined ? undefined : new Set(topics);

  const handler: FetchHandler = async (request) => {
    if (request.method !== "GET") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    }

    const topic = topicOf(request);
    if (topic === "" || (allowed !== undefined && !allowed.has(topic))) {
      return new Response("no such topic", { status: 404 });
    }

    const header = request.headers.get("last-event-id");
    const parsed = header === null ? Number.NaN : Number(header);
    const usable = header !== null && Number.isSafeInteger(parsed) && parsed >= 0;
    // An id we cannot read is not a fresh client: it had history and lost it, so
    // it gets a gap rather than silence.
    const forceGap = header !== null && !usable;

    const stream = new ReadableStream<Uint8Array>(
      createSseSource(broker, topic, {
        ...(usable ? { replayFrom: parsed } : {}),
        forceGap,
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
      }),
    );

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
    topicCount: () => broker.topicCount(),
  };
}
