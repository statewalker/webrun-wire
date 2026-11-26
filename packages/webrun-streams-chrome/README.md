# @statewalker/webrun-streams-chrome

## What it is

The pipes that carry `@statewalker/webrun-rpc`'s port stack between the parts of a Chrome
extension: a page, its content script, the service worker and an offscreen document. A page that
calls a method on the service worker looks like this:

```ts
// page
const pipe = messagePortPipe(portFromContentScript);
const mux = multiplexPort(pipe.target, { codec: msgpackCodec, signal: pipe.signal, window: "auto" });
const tabs = methodsClient<Tabs>(await mux.openPort({ kind: "tabs" }), {
  channelName: "tabs",
  methods: ["list"],
});
console.log(await tabs.list());
```

Three functions do the work:

- `chromePortPipe(port)` turns a `chrome.runtime.Port` into a pipe of bytes;
- `messagePortPipe(port)` does the same for a `MessagePort`, which is how a page and its content
  script talk;
- `relayPipes(a, b)` relays bytes between two pipes, for the content script in the middle.

Each returns the `{ target, signal, maxMessageSize }` every `webrun-streams-*` adapter returns, so
`overPipe`, `multiplexPort`, `serveMethods`, `callBidi` and `fetchOverDuplex` run over them as over
a WebSocket.

## Why it exists

A `chrome.runtime.Port` carries JSON and nothing else: no `ArrayBuffer`, no transferables. It has
no buffered amount, and it says it is gone only through `onDisconnect`. A page cannot open one at
all: it reaches the extension through a content script, over a `MessagePort` that tells neither
side when the other closes. And a service worker stops whenever Chrome decides it has been idle,
taking every open call with it.

This package hides those differences. Frames cross a Chrome port as base64 strings (native
`Uint8Array.toBase64` where the runtime has it). A disconnect ends the pipe, with
`chrome.runtime.lastError` in the reason when Chrome set one. A `MessagePort` pipe posts a small
"closed" message before it closes, carrying the reason. The relay closes each side with the
reason the other side ended with. So when the service worker stops, every call the page has
pending fails within milliseconds with one chained reason:

```
page<->cs: the peer closed: cs<->sw: the chrome.runtime.Port disconnected
```

and the page knows to reconnect, which wakes a fresh worker.

## How to use

```sh
pnpm add @statewalker/webrun-streams-chrome @statewalker/webrun-rpc @statewalker/webrun-msgpack
```

`@statewalker/webrun-streams` is its one runtime dependency. It needs no `@types/chrome`: it takes
any object shaped like a port (`ChromePortLike`, `MessagePortLike`).

### The service worker: a broker

Accept each connection, run one multiplexer over it, and route each port by its meta:

```ts
import { msgpackCodec } from "@statewalker/webrun-msgpack";
import { listenBidi, multiplexPort, serveMethods } from "@statewalker/webrun-rpc";
import { chromePortPipe } from "@statewalker/webrun-streams-chrome";

chrome.runtime.onConnect.addListener((port) => {
  const pipe = chromePortPipe(port);
  multiplexPort(pipe.target, {
    codec: msgpackCodec,
    side: "responder",
    window: "auto",
    signal: pipe.signal,
    maxMessageSize: pipe.maxMessageSize,
    onPort: (p, meta) => {
      if (meta?.kind === "tabs") serveMethods(p, tabs, { channelName: "tabs", methods: ["list"] });
      if (meta?.kind === "events") listenBidi(p, tabEvents);
    },
  });
});
```

`port.sender` (url, origin, tab, frame) is still on the port: read it before you hand the port
over, to decide what this caller may do.

### The content script: a relay

```ts
import { chromePortPipe, messagePortPipe, relayPipes } from "@statewalker/webrun-streams-chrome";

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "connect") return;
  const channel = new MessageChannel();
  relayPipes(messagePortPipe(channel.port1), chromePortPipe(chrome.runtime.connect()));
  window.postMessage({ type: "connected" }, "*", [channel.port2]);
});
```

The relay never decodes the multiplexer: bytes in, the same bytes out.

### The page: a client

Ask the content script for a port, run a multiplexer over `messagePortPipe(port)` as in the first
example, and open one port per purpose. For an event stream, open a port per subscription and let
`callBidi` close it when the loop ends:

```ts
const port = await mux.openPort({ kind: "events" });
for await (const event of callBidi(port, [], { options: { closePort: true } })) {
  if (event.done) break; // the worker's generator runs its finally
}
```

When `pipe.signal` aborts, the connection is dead: mark it so, and reconnect on the next call.
The worker's state went with it, so subscribe again.

### Exports

| Export | What it gives |
| --- | --- |
| `chromePortPipe(port, options?)` | A `chrome.runtime.Port` as a `MessagePipe`. Options: `maxFrameBytes` (default 32 MiB, before base64: Chrome refuses a message over 64 MiB of JSON), `maxMessageSize` (default 1 MiB), `name` (the prefix of its errors). Closing it disconnects the port. |
| `messagePortPipe(port, options?)` | A `MessagePort` as a `MessagePipe`: each frame a copy whose buffer is transferred. Options: `maxMessageSize` (default none), `name`. Closing it posts `{ type: "webrun-pipe-closed", reason }` first. |
| `relayPipes(a, b)` | Relays bytes both ways and links the two ends. Returns `stop(reason?)`, which closes both. |
| `bytesToBase64`, `base64ToBytes`, `NATIVE_BASE64` | The base64 the Chrome pipe uses. |
| `PIPE_CLOSED` | `"webrun-pipe-closed"`, the type of the close message. |
| `ChromePortLike`, `ChromeEventLike`, `MessagePortLike` | The shapes the pipes accept. |
| `DEFAULT_MAX_FRAME_BYTES`, `DEFAULT_MAX_MESSAGE_SIZE` | 32 MiB and 1 MiB. |

Frames of 256 KiB to 1 MiB stream fastest: in headless Chromium a 5 MiB body takes about 50 to
130 ms to download from the worker through the relay, and a single call under a millisecond.

## Internals

Both pipes are built on `newMessagePipe` from `@statewalker/webrun-streams`, which owns the rules
every pipe keeps (one life, a listener that throws stops nothing, a frame ceiling, a drain wait);
each adapter supplies only how to send, how to close and when the transport ended. Neither
transport reports buffered bytes, so flow control is the multiplexer's per-port window, end to
end (`window: "auto"`).

A `MessagePort` delivers what was posted before `close()`, so the close message reaches the peer
before the port goes. A pipe that receives it ends without posting one back.

## Tests

`pnpm test` runs, against a fake `chrome.runtime.Port` that serialises JSON and delivers
asynchronously as Chrome does:

- the message pipe contract of `@statewalker/webrun-streams-conformance` for both pipes;
- the Duplex conformance suite (L0 to L6) over a Chrome pipe pair, and again through the whole
  page, relay and worker path;
- request/response, an event stream cancelled by `break`, and a stopped worker failing every
  pending call with the chained reason.

`pnpm test:extension` is opt-in and not run by CI: it builds a test extension, loads it into
Playwright's Chromium (`channel: "chromium"`, headless; the headless shell loads no extensions)
and runs the same scenarios through a real `chrome.runtime.Port`, plus a streamed fetch of 5 MiB
each way and a service worker stopped over CDP under load. Build the workspace first
(`pnpm -r run build`).
