/**
 * In-memory two-party signaling bus: a pair of {@link SignalingTransport}s wired
 * to each other. Messages sent to a peer id are delivered to that endpoint's
 * handlers on a microtask (loosely mimicking an async side-channel).
 */

import type { SignalingMessage, SignalingTransport } from "../../src/types.js";

export function makeSignalingPair(
  idA = "A",
  idB = "B",
): [SignalingTransport, SignalingTransport] {
  const handlers: Record<string, Set<(from: string, msg: SignalingMessage) => void>> = {
    [idA]: new Set(),
    [idB]: new Set(),
  };

  const make = (self: string, other: string): SignalingTransport => ({
    localId: self,
    send(to, msg) {
      if (to !== other) return;
      queueMicrotask(() => {
        for (const handler of handlers[other]) handler(self, msg);
      });
    },
    onMessage(handler) {
      handlers[self].add(handler);
      return () => handlers[self].delete(handler);
    },
  });

  return [make(idA, idB), make(idB, idA)];
}
