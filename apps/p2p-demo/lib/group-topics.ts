/**
 * Per-group gossipsub topic names. Two topics serve different concerns:
 *
 * - `peerDiscoveryTopic(groupId)` is consumed by `@libp2p/pubsub-peer-discovery`.
 *   It carries `{peerId, multiaddrs}` and feeds libp2p's discovery pipeline
 *   (auto-dial). The library subscribes / publishes on this topic itself.
 *
 * - `servicesTopic(groupId)` is our own custom topic. It carries
 *   `ServiceAnnouncement` messages (the capability catalog plus eviction
 *   metadata) and is owned by `joinGroup`.
 *
 * Both topics share the `webrun/<groupId>/` prefix so the relay's
 * auto-subscribe rule (any incoming `webrun/*` subscription it sees) picks
 * them up without per-topic configuration.
 */
export function peerDiscoveryTopic(groupId: string): string {
  return `webrun/${groupId}/peer-discovery`;
}

export function servicesTopic(groupId: string): string {
  return `webrun/${groupId}/services`;
}
