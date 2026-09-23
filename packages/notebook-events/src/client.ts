import type { Unsubscribe } from "./broker.js";

/** The SSE event type a subscription listens for when nothing else is asked for. */
const DEFAULT_EVENTS = ["message"] as const;

export interface PubSubClientOptions {
  /** Injected for tests, and for runtimes with a non-global EventSource. */
  EventSourceImpl?: typeof EventSource;
  /**
   * Default event names for every subscription on this client; `["message"]`
   * unless given. A frame published with `event: X` is dispatched by the browser
   * ONLY as type X — it does not also fire `message` — so a name that is not
   * listed here is received by nobody.
   */
  events?: readonly string[];
  /**
   * Called when the server reports it could not replay the client's full
   * history. The caller should re-sync from scratch rather than assume the
   * events it did receive are complete.
   *
   * A gap is not the only way a subscription stops being trustworthy: a stream
   * that fails permanently is reported through {@link PubSubClientOptions.onError}.
   */
  onGap?: (topic: string) => void;
  /**
   * Called when the stream errors. `EventSource` retries a dropped connection on
   * its own, but a non-2xx response or a wrong content-type closes it FOR GOOD —
   * the subscription is then dead and this is the only notice of it. Check
   * `readyState === 2` (CLOSED) to tell the two apart, and resubscribe.
   */
  onError?: (topic: string, e: Event) => void;
  /** Called when the stream opens, including after `EventSource`'s own reconnect. */
  onOpen?: (topic: string) => void;
}

export interface SubscribeOptions {
  /** Event names for this subscription, overriding the client's default set. */
  events?: readonly string[];
}

export interface PubSubClient {
  subscribe(
    topic: string,
    cb: (data: unknown, e: { id: number; event?: string }) => void,
    options?: SubscribeOptions,
  ): Unsubscribe;
  close(): void;
}

export function newPubSubClient(
  baseUrl: string,
  { EventSourceImpl, events, onGap, onError, onOpen }: PubSubClientOptions = {},
): PubSubClient {
  const Impl = EventSourceImpl ?? globalThis.EventSource;
  if (!Impl) throw new Error("no EventSource available; pass options.EventSourceImpl");

  const open = new Set<EventSource>();
  const base = baseUrl.replace(/\/$/, "");
  const defaultEvents = events ?? DEFAULT_EVENTS;

  return {
    subscribe(topic, cb, options = {}) {
      const source = new Impl(`${base}/${topic}`);
      open.add(source);

      const names = options.events ?? defaultEvents;
      const listeners: Array<[string, (e: Event) => void]> = [];
      const on = (type: string, fn: (e: Event) => void) => {
        listeners.push([type, fn]);
        source.addEventListener(type, fn);
      };

      for (const name of names) {
        on(name, (e) => {
          const m = e as MessageEvent;
          cb(JSON.parse(m.data), {
            id: Number(m.lastEventId),
            // `message` is the unnamed default; anything else names itself.
            ...(name === "message" ? {} : { event: name }),
          });
        });
      }
      // The gap signal is the client half of the replay contract; it never
      // reaches the subscriber, which would mistake it for a payload.
      on("gap", () => onGap?.(topic));
      on("error", (e) => onError?.(topic, e));
      on("open", () => onOpen?.(topic));

      return () => {
        for (const [type, fn] of listeners) source.removeEventListener(type, fn);
        listeners.length = 0;
        source.close();
        open.delete(source);
      };
    },

    close() {
      for (const s of open) s.close();
      open.clear();
    },
  };
}
