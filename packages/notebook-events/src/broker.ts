export type BrokerEvent = { id: number; event?: string; data: unknown };
export type Subscriber = (e: BrokerEvent) => void;
export type Unsubscribe = () => void;

export interface Broker {
  publish(topic: string, data: unknown, event?: string): BrokerEvent;
  subscribe(topic: string, fn: Subscriber, lastEventId?: number): Unsubscribe;
  replay(topic: string, afterId: number): { events: BrokerEvent[]; complete: boolean };
  subscriberCount(topic: string): number;
}

export interface BrokerOptions {
  /** How many recent events to retain per topic for Last-Event-ID replay. */
  bufferSize?: number;
}

type TopicState = {
  nextId: number;
  /** Bounded ring of recent events, oldest first. */
  buffer: BrokerEvent[];
  /** Minimal: one subscriber. Task 2's failing test is what makes this a Set. */
  subscriber?: Subscriber;
};

export function newBroker({ bufferSize = 64 }: BrokerOptions = {}): Broker {
  const topics = new Map<string, TopicState>();

  const state = (topic: string): TopicState => {
    let s = topics.get(topic);
    if (!s) topics.set(topic, (s = { nextId: 1, buffer: [] }));
    return s;
  };

  return {
    publish(topic, data, event) {
      const s = state(topic);
      const e: BrokerEvent = { id: s.nextId++, data, ...(event === undefined ? {} : { event }) };
      s.buffer.push(e);
      if (s.buffer.length > bufferSize) s.buffer.shift();
      s.subscriber?.(e);
      return e;
    },

    subscribe(topic, fn, lastEventId) {
      const s = state(topic);
      if (lastEventId !== undefined) for (const e of this.replay(topic, lastEventId).events) fn(e);
      s.subscriber = fn;
      return () => {
        s.subscriber = undefined;
      };
    },

    replay(topic, afterId) {
      const s = topics.get(topic);
      if (!s) return { events: [], complete: true };
      const events = s.buffer.filter((e) => e.id > afterId);
      // Incomplete when the requested point predates the oldest retained event.
      const oldest = s.buffer[0]?.id;
      const complete = oldest === undefined || afterId >= oldest - 1;
      return { events, complete };
    },

    subscriberCount(topic) {
      return topics.get(topic)?.subscriber ? 1 : 0;
    },
  };
}
