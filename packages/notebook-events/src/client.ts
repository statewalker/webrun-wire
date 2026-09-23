import type { Unsubscribe } from "./broker.js";

export interface PubSubClientOptions {
  /** Injected for tests, and for runtimes with a non-global EventSource. */
  EventSourceImpl?: typeof EventSource;
  /**
   * Called when the server reports it could not replay the client's full
   * history. The caller should re-sync from scratch rather than assume the
   * events it did receive are complete.
   */
  onGap?: (topic: string) => void;
}

export interface PubSubClient {
  subscribe(
    topic: string,
    cb: (data: unknown, e: { id: number; event?: string }) => void,
  ): Unsubscribe;
  close(): void;
}

export function newPubSubClient(
  baseUrl: string,
  { EventSourceImpl, onGap }: PubSubClientOptions = {},
): PubSubClient {
  const Impl = EventSourceImpl ?? globalThis.EventSource;
  if (!Impl) throw new Error("no EventSource available; pass options.EventSourceImpl");

  const open = new Set<EventSource>();
  const base = baseUrl.replace(/\/$/, "");

  return {
    subscribe(topic, cb) {
      const source = new Impl(`${base}/${topic}`);
      open.add(source);

      const onMessage = (e: MessageEvent) => {
        cb(JSON.parse(e.data), { id: Number(e.lastEventId) });
      };
      const onGapEvent = () => onGap?.(topic);
      const onRebuilt = (e: MessageEvent) => {
        cb(JSON.parse(e.data), { id: Number(e.lastEventId), event: "rebuilt" });
      };

      source.addEventListener("message", onMessage);
      source.addEventListener("gap", onGapEvent);
      // Named events published with an `event:` line do not fire "message".
      source.addEventListener("rebuilt", onRebuilt);

      return () => {
        source.removeEventListener("message", onMessage);
        source.removeEventListener("gap", onGapEvent);
        source.removeEventListener("rebuilt", onRebuilt);
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
