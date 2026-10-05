# @statewalker/webrun-http-events

## What it is

Publish/subscribe over
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).
The server half is a standard `(Request) => Promise<Response>` handler that
streams `text/event-stream`; the client half wraps `EventSource` and delivers
parsed payloads per topic. Topics and event names are yours; the package has no
vocabulary of its own.

## Why it exists

Pushing events from a worker, a ServiceWorker or a Node process to a page needs
more than a stream of frames. A reconnecting `EventSource` has to get back what
it missed, a client that cannot get it back has to be told so, a named event
has to reach the listener that expects it, and a subscription that dies has to
be reported. This package implements those rules once, on top of a plain fetch
handler, so it runs wherever a `Request`/`Response` handler runs: behind a
`@statewalker/webrun-http-browser` ServiceWorker, inside a `Duplex` from
`@statewalker/webrun-http-streams`, or on a real HTTP server.

## How to use

```sh
pnpm add @statewalker/webrun-http-events
```

- **Peer dependencies:** none. **Runtime dependencies:** none.
- **Entry point:** one, `.`. ESM only: `dist/index.mjs` with
  `dist/index.d.mts`, built by tsdown. The `source` export condition points at
  `src/index.ts`.
- **Environment:** the server half (`newPubSub`, `newBroker`,
  `formatSseEvent`) uses no DOM API and runs in a page, a Worker, a
  ServiceWorker or Node. The client half (`newPubSubClient`) needs an
  `EventSource`: the global one in a browser, or one passed as
  `EventSourceImpl` elsewhere.

| Export | What it is |
| --- | --- |
| `newPubSub(options?)` | `{ handler, publish, subscriberCount, topicCount }`. Types: `PubSub`, `PubSubOptions`, `FetchHandler`. |
| `newPubSubClient(baseUrl, options?)` | `{ subscribe(topic, cb, options?), close() }`. Types: `PubSubClient`, `PubSubClientOptions`, `SubscribeOptions`. |
| `newBroker(options?)` | The in-memory topic broker behind `newPubSub`: `publish`, `subscribe`, `replay`, `subscriberCount`, `topicCount`. Types: `Broker`, `BrokerEvent`, `BrokerOptions`, `Subscriber`, `Unsubscribe`. |
| `formatSseEvent(event)` | Formats one `{ id, event?, data }` as an SSE frame. |

## Examples

### Server

```ts
import { newPubSub } from "@statewalker/webrun-http-events";

const events = newPubSub({ topics: ["build"], bufferSize: 64 });

// Mount the handler on any fetch-style router; the topic is the last path segment.
// GET /_events/build  ->  text/event-stream
export const fetch = (request: Request) => events.handler(request);

events.publish("build", { changed: ["/index.html"] }, "rebuilt");
```

| `newPubSub` option | Default | Meaning |
| --- | --- | --- |
| `topics` | none | Allow-list of topic names. Without it any request path allocates a topic, so set it on a public endpoint. |
| `bufferSize` | `64` | Events retained per topic for `Last-Event-ID` replay. |
| `heartbeatMs` | `0` | Interval for `: ping` comment frames, which keep a half-open connection visible to proxies. `0` means no heartbeat. |
| `onSubscriberError` | none | `(error, event)`, called when a subscriber throws. Delivery to the others continues either way. |

The handler answers `405 method not allowed` (with `allow: GET`) to anything
but `GET`, and `404 no such topic` to an empty or unlisted topic. A stream
response carries `cache-control: no-cache` and `x-accel-buffering: no`, which
stops proxy buffering from stalling delivery.

### Client

```ts
import { newPubSubClient } from "@statewalker/webrun-http-events";

const client = newPubSubClient("/_events", {
  events: ["message", "rebuilt"], // see "A named event fires only under its name"
  onGap: (topic) => location.reload(), // history could not be replayed: re-sync
  onError: (topic, e) => console.warn("subscription failed", topic, e),
});

const off = client.subscribe("build", (data, { id, event }) => {
  console.log(id, event, data);
});

// later
off(); // one subscription
client.close(); // every subscription of this client
```

Each `subscribe` opens one `EventSource` on `<baseUrl>/<topic>`. Options:
`events`, `onGap`, `onError`, `onOpen`, and `EventSourceImpl` for runtimes
without a global `EventSource`. With no `EventSource` at all,
`newPubSubClient` throws `no EventSource available; pass options.EventSourceImpl`.

### Broker and frames without HTTP

```ts
import { formatSseEvent, newBroker } from "@statewalker/webrun-http-events";

const broker = newBroker({ bufferSize: 2 });
const off = broker.subscribe("t", (e) => console.log(e.id, e.data));
broker.publish("t", 1);
broker.publish("t", 2);
broker.publish("t", 3);

broker.replay("t", 0); // { events: [id 2, id 3], complete: false } — id 1 was evicted
broker.replay("t", 1); // { events: [id 2, id 3], complete: true }

formatSseEvent({ id: 1, event: "x", data: "hi" }); // 'id: 1\nevent: x\ndata: "hi"\n\n'
off();
```

## Internals

### A named event fires only under its name

A frame published with a name (`publish(topic, data, "rebuilt")`) is
dispatched by `EventSource` only under that name; it does not also fire
`message`. So every name a page wants must be listed, per client (`events`) or
per subscription (`subscribe(topic, cb, { events })`). The default is
`["message"]`, which is what an unnamed `publish(topic, data)` produces.

`gap`, `error` and `open` are reserved. They are the client's control channels,
reported through `onGap`, `onError` and `onOpen`. Listing one as a data event
throws, before any `EventSource` is opened:

```
TypeError: newPubSubClient: "gap" is a reserved event name — it is delivered to onGap, not to a subscriber
```

A `gap` delivered as data would let the caller patch forward from a history it
believes complete, and `error`/`open` carry a bare `Event` with no data to
parse.

### Replay is all or nothing

Every event carries a per-topic id starting at 1. A reconnecting `EventSource`
sends `Last-Event-ID`, and the server replays what it still retains. When it
cannot reconstruct the client's history, it sends a `gap` frame first instead
of a partial replay that would look whole:

- the requested events were evicted from the ring of `bufferSize`;
- the id is above anything this server issued (a client left over from a
  previous process);
- the header is not a non-negative safe integer.

`onGap` means "you are not current": reload or re-sync rather than patch
forward.

### A permanent failure is reported once

`EventSource` reconnects on its own after a dropped connection, but a non-2xx
response or a wrong content type closes it for good. That is reported through
`onError`; check `readyState === 2` (CLOSED) to tell the two apart. A
subscription that died is never resurrected by itself.

### Delivery is synchronous and isolated

`publish` delivers to every subscriber before it returns. A subscriber that
throws is reported to `onSubscriberError` and does not starve the others or the
publisher; a reporter that throws is swallowed for the same reason. A stream
whose client went away, or whose frame cannot be produced, unsubscribes itself.

Reentrant publishing (calling `publish` from inside a subscriber) is not
supported. The inner event is delivered to completion first, so subscribers
observe ids out of order and a client's `Last-Event-ID` can move backwards.
Publish from a fresh task instead.

A topic with no subscribers and no retained events is dropped, so topic names
taken from request paths do not accumulate.

### Framing

`data` is always JSON-serialised, strings included, and every line is prefixed
with `data: `. A payload JSON cannot represent (`undefined`, a function, a
symbol, a BigInt, a circular object) is framed as `null`; the event still
reaches the client with its id and name. CR and LF are stripped from event
names, since a newline there would inject frames.

### Dependencies

Zero runtime dependencies; only platform APIs (`Request`, `Response`,
`ReadableStream`, `TextEncoder`, `EventSource` on the client).
`@statewalker/webrun-http-browser` is a dev dependency, used by the browser
test.

### Tests

- `pnpm test`: builds with tsdown, then runs the unit tests with a fake
  `EventSource` and in-process responses.
- `pnpm run test:browser`: drives a real Chromium tab through a real
  ServiceWorker (`@statewalker/webrun-http-browser`'s `sw-worker.js`) and a
  real `text/event-stream` fetch, including past the 30 s ServiceWorker idle
  window.
- `pnpm run typecheck`.

## License

MIT
