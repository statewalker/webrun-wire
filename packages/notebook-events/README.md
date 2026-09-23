# @statewalker/notebook-events

Generic publish/subscribe over [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html):
a standard `FetchHandler` on the server side and a matching `EventSource` client on the page side.

No runtime dependencies, no DOM APIs on the server half (it runs in a Worker, a ServiceWorker or
Node), and no vocabulary of its own — topics and event names are yours.

```sh
npm install @statewalker/notebook-events
```

## Server

```ts
import { newPubSub } from "@statewalker/notebook-events";

const events = newPubSub({ topics: ["build"], bufferSize: 64 });

// Mount the handler on any fetch-style router; the topic is the last path segment.
// GET /_events/build  ->  text/event-stream
export const fetch = (request: Request) => events.handler(request);

events.publish("build", { changed: ["/index.html"] }, "rebuilt");
```

`newPubSub(options)`:

| option | meaning |
| --- | --- |
| `topics` | Allow-list of topic names. Without it, any request path allocates a topic — set it on a public endpoint. |
| `bufferSize` | Events retained per topic for `Last-Event-ID` replay (default 64). |
| `heartbeatMs` | Interval for `: ping` comment frames. 0 (default) means no heartbeat. |
| `onSubscriberError` | Called when a subscriber throws; delivery to the others continues either way. |

The handler answers `405` to anything but `GET` and `404` to an unknown or empty topic.

## Client

```ts
import { newPubSubClient } from "@statewalker/notebook-events";

const client = newPubSubClient("/_events", {
  events: ["message", "rebuilt"], // see "event names" below
  onGap: (topic) => location.reload(), // history could not be replayed: re-sync
  onError: (topic, e) => console.warn("subscription failed", topic, e),
});

const off = client.subscribe("build", (data, { id, event }) => {
  console.log(id, event, data);
});
```

### Event names

A frame published with a name (`publish(topic, data, "rebuilt")`) is dispatched by `EventSource`
**only** under that name — it does not also fire `message`. So every name a page wants must be
listed, either per client (`events`) or per subscription (`client.subscribe(topic, cb, { events })`).
The default is `["message"]`, which is what an unnamed `publish(topic, data)` produces.

### Gaps

Every event carries an id. A reconnecting `EventSource` sends `Last-Event-ID`, and the server
replays what it still retains. When it cannot reconstruct the client's history — the events were
evicted, the id predates a server restart, or the header was unreadable — it sends a `gap` event
instead of a partial replay that would look whole. `onGap` means *you are not current*: reload or
re-sync rather than patching forward.

### Permanent failure

`EventSource` reconnects on its own after a dropped connection, but a non-2xx response or a wrong
content-type closes it for good. That is reported through `onError` (check `readyState === 2`); a
subscription that died is never resurrected by itself.

## Notes

- Reentrant publishing — calling `publish` from inside a subscriber — is not supported: the inner
  event is delivered to completion first, so subscribers observe ids out of order.
- A payload JSON cannot represent (`undefined`, a function, a symbol, a BigInt, a circular object)
  is framed as `null`; the event still reaches the client with its id and name.

## License

MIT
