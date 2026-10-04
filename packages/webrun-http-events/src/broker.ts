export type BrokerEvent = { id: number; event?: string; data: unknown };
export type Subscriber = (e: BrokerEvent) => void;
export type Unsubscribe = () => void;

export interface Broker {
  /**
   * Deliver `data` to every subscriber of `topic` and retain it for replay.
   *
   * Delivery is synchronous and each subscriber is isolated: one that throws is
   * reported to `onSubscriberError` and cannot starve the others or the caller.
   *
   * Publishing from inside a subscriber (a reentrant publish) is NOT supported:
   * the inner event is delivered to completion before the outer one finishes, so
   * subscribers observe ids out of order and a client's Last-Event-ID can move
   * backwards. Publish from a fresh task instead.
   */
  publish(topic: string, data: unknown, event?: string): BrokerEvent;
  /** Register `fn` for future events on `topic`. Use {@link Broker.replay} for history. */
  subscribe(topic: string, fn: Subscriber): Unsubscribe;
  /**
   * Events retained after `afterId`, plus whether that is the whole story.
   * `complete: false` means the caller's history cannot be reconstructed — either
   * the events it wants were evicted, or its `afterId` is above anything this
   * broker has issued (a client left over from a previous process).
   */
  replay(topic: string, afterId: number): { events: BrokerEvent[]; complete: boolean };
  subscriberCount(topic: string): number;
  /** How many topics currently hold state. Topics with no subscribers and no retained events are dropped. */
  topicCount(): number;
}

export interface BrokerOptions {
  /** How many recent events to retain per topic for Last-Event-ID replay. */
  bufferSize?: number;
  /**
   * Called when a subscriber throws. Delivery continues either way; without this
   * the failure would be invisible.
   */
  onSubscriberError?: (error: unknown, e: BrokerEvent) => void;
}

type TopicState = {
  nextId: number;
  /** Bounded ring of recent events, oldest first. */
  buffer: BrokerEvent[];
  subscribers: Set<Subscriber>;
};

export function newBroker({ bufferSize = 64, onSubscriberError }: BrokerOptions = {}): Broker {
  const topics = new Map<string, TopicState>();

  const state = (topic: string): TopicState => {
    let s = topics.get(topic);
    if (!s) {
      s = { nextId: 1, buffer: [], subscribers: new Set() };
      topics.set(topic, s);
    }
    return s;
  };

  /** Drop a topic that holds nothing, so request-driven names cannot accumulate. */
  const prune = (topic: string, s: TopicState): void => {
    if (topics.get(topic) === s && s.subscribers.size === 0 && s.buffer.length === 0) {
      topics.delete(topic);
    }
  };

  const replay: Broker["replay"] = (topic, afterId) => {
    const s = topics.get(topic);
    // An absent topic has issued nothing: only a caller with no history is current.
    if (!s) return { events: [], complete: afterId <= 0 };
    const events = s.buffer.filter((e) => e.id > afterId);
    const latest = s.nextId - 1;
    // An empty ring retains nothing, so nothing before `nextId` can be reconstructed.
    const oldest = s.buffer[0]?.id ?? s.nextId;
    // Incomplete below, when the requested point predates the oldest retained event,
    // and above, when it names an id this broker never issued.
    return { events, complete: afterId >= oldest - 1 && afterId <= latest };
  };

  return {
    publish(topic, data, event) {
      const s = state(topic);
      const e: BrokerEvent = { id: s.nextId++, data, ...(event === undefined ? {} : { event }) };
      s.buffer.push(e);
      if (s.buffer.length > bufferSize) s.buffer.shift();
      // Copy before iterating: a subscriber may unsubscribe during delivery.
      for (const fn of [...s.subscribers]) {
        try {
          fn(e);
        } catch (error) {
          try {
            onSubscriberError?.(error, e);
          } catch {
            // A reporter that throws must not starve the remaining subscribers either.
          }
        }
      }
      return e;
    },

    subscribe(topic, fn) {
      const s = state(topic);
      s.subscribers.add(fn);
      return () => {
        s.subscribers.delete(fn);
        prune(topic, s);
      };
    },

    replay,

    subscriberCount(topic) {
      return topics.get(topic)?.subscribers.size ?? 0;
    },

    topicCount() {
      return topics.size;
    },
  };
}
