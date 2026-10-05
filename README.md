# webrun-wire

This repository holds packages that move bytes, `Request`/`Response` pairs, RPC calls and async
iterators over any channel that can carry bytes: a MessagePort, a WebSocket, a WebRTC data channel,
a libp2p stream, a LiveKit room, a PeerJS connection, a ServiceWorker, an in-process pipe or real
HTTP. The same handler code runs on both ends whatever the channel. All packages are published to
npm under `@statewalker/`.

## The shape: one seam, adapters below it, protocols above it

Everything meets at one type, defined in `@statewalker/webrun-streams`:

```ts
type Duplex = (input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => AsyncGenerator<Uint8Array>;
```

Bytes in, bytes out. A handler is a `Duplex`, and a transport adapter produces one, so an in-process
test can use the handler itself as the caller, and the same handler then moves to a WebSocket or a
WebRTC channel by changing the adapter. Iterator semantics carry every signal: a consumer's
`.return()` runs the producer's `finally`, a producer's `throw` surfaces in the consumer's
`for await`, and exhaustion ends the other side.

```
           protocols:  webrun-http-streams   webrun-rpc   webrun-msgpack   webrun-http-browser
                                  \              |              /                /
                                   v             v             v                v
  seam:                         webrun-streams  (Duplex, Connect, Serve, ByteChannel, emulateMux)
                                   ^             ^             ^                ^
                                  /              |              \                \
           adapters:  webrun-streams-ws  -webrtc  -libp2p  -livekit  -peerjs   (+ -signaling to set up P2P)

  standalone:  webrun-rpc-http (needs only webrun-streams)   webrun-http-events, webrun-http-proxy (no deps)
  testing:     webrun-streams-conformance (the suite every adapter passes)
```

Message-oriented transports (WebSocket, MessagePort, LiveKit, PeerJS) supply a `ByteChannel`, and
`emulateMux` runs many concurrent streams over it. Transports that multiplex natively (WebRTC data
channels, libp2p) skip `emulateMux`.

### Packages

| Package | What it gives | Depends on |
| --- | --- | --- |
| [`@statewalker/webrun-streams`](./packages/webrun-streams) | The `Duplex` seam, `emulateMux`, async-iterator, stream, text/JSONL and error primitives | nothing |
| [`@statewalker/webrun-rpc`](./packages/webrun-rpc) | Port multiplexing and typed request/response and streaming RPC over any `MessageTarget` | webrun-streams |
| [`@statewalker/webrun-msgpack`](./packages/webrun-msgpack) | MessagePack, length-prefixed stream codecs, a byte codec for `webrun-rpc` ports | webrun-rpc |
| [`@statewalker/webrun-http-streams`](./packages/webrun-http-streams) | HTTP/1.1 request/response over a `Duplex` | webrun-streams |
| [`@statewalker/webrun-http-browser`](./packages/webrun-http-browser) | A ServiceWorker-based HTTP server for browsers, same-origin and relay modes | webrun-http-streams, webrun-rpc, webrun-streams, `idb-keyval` |
| [`@statewalker/webrun-rpc-http`](./packages/webrun-rpc-http) | Object methods as a `(Request) => Response` handler, called with `fetch` | webrun-streams |
| [`@statewalker/webrun-http-events`](./packages/webrun-http-events) | Publish/subscribe over Server-Sent Events: a fetch handler and a client | nothing |
| [`@statewalker/webrun-http-proxy`](./packages/webrun-http-proxy) | Re-issue a request to an outside origin safely | nothing |
| [`@statewalker/webrun-streams-ws`](./packages/webrun-streams-ws) | WebSocket adapter | webrun-streams |
| [`@statewalker/webrun-streams-webrtc`](./packages/webrun-streams-webrtc) | WebRTC data channel adapter, one channel per call | webrun-streams |
| [`@statewalker/webrun-streams-libp2p`](./packages/webrun-streams-libp2p) | libp2p stream adapter | webrun-streams; peers `@libp2p/interface`, `@multiformats/multiaddr`, optional `libp2p` |
| [`@statewalker/webrun-streams-livekit`](./packages/webrun-streams-livekit) | LiveKit data channel adapter | webrun-streams; peer `livekit-client` |
| [`@statewalker/webrun-streams-peerjs`](./packages/webrun-streams-peerjs) | PeerJS `DataConnection` adapter | webrun-streams; peer `peerjs` |
| [`@statewalker/webrun-streams-signaling`](./packages/webrun-streams-signaling) | P2P connection setup (`PeerManager`, `QrSignaling`, `RoomManager`) yielding `ByteChannel`s | webrun-streams; optional peer `livekit-client` |
| [`@statewalker/webrun-streams-conformance`](./packages/webrun-streams-conformance) | The Vitest suite every adapter must pass | webrun-streams, `vitest` |

Every package is public on npm (`https://www.npmjs.com/package/@statewalker/<name>`), ESM-only,
and ships built JavaScript with type declarations in `dist/` plus its TypeScript sources in `src/`.
`tools/consumer-install` is a private test harness (see its README).

## How to run it

1. Use Node.js 24 and enable corepack, which provides the pinned pnpm (`packageManager:
   pnpm@10.16.1`):

   ```sh
   corepack enable
   ```

2. Install and test:

   ```sh
   pnpm install
   pnpm test        # every package's tests, plus tools/consumer-install
   ```

3. Build when you need `dist/` (publishing, the browser demos, the consumer-install harness):

   ```sh
   pnpm build
   ```

4. Before pushing, run what CI runs:

   ```sh
   pnpm lint:check
   pnpm format:check
   pnpm typecheck
   ```

5. Browser tests are separate scripts in the packages that have them, for example
   `pnpm --filter @statewalker/webrun-http-browser test:browser`.

## Why it is the way it is

**One seam instead of one API per transport.** Every transport is reduced to a `Duplex` (or a
`ByteChannel` that `emulateMux` turns into one). Protocols above it (HTTP, RPC) never see the
transport, and a new transport only has to pass `webrun-streams-conformance` to work with all of
them.

**Bundles keep their dependencies external.** Each package's `rolldown.config.js` takes its
externals from its own `package.json` through `rolldown.preset.js`: everything declared as a
dependency or peer stays external, nothing else does. The package manager installs those for the
consumer anyway, so inlining them would ship a second copy, and a second copy of
`@statewalker/webrun-streams` means a second `TransportClosedError` class, which breaks
`instanceof` across package boundaries. Deriving the list from the manifest keeps it from drifting.

**`webrun-http-browser` is the one exception.** Its shipped HTML (`public-relay/relay.html`,
`demo/*.html`) imports `../dist/index.js` from a static host with no import map, and its two IIFE
service-worker runtimes are loaded with `importScripts(...)`, which cannot resolve a bare
specifier. So every output of that package is one self-contained file, at the cost of a duplicated
copy of `webrun-streams` inside it. Don't rely on `instanceof` across that package's boundary.

**Tooling inside the repository reads `src`, not `dist`.** `tsconfig.base.json` maps
`@statewalker/webrun-*` to `packages/*/src` through `paths`, and `vitest.config.ts` builds the
matching `resolve.alias` list from the `packages/` directory. Without that, the `exports` maps
would send tests to `dist/` and they would run against the last build instead of the working tree.
Published consumers only ever see `dist`.

## What will surprise you

- **`pnpm test` packs and installs with npm.** `tools/consumer-install` runs `pnpm pack` on
  `webrun-http-browser` and its workspace dependencies (each pack runs a `prepack` build) and then a
  real `npm install` of the tarballs from the npm registry. It needs network access and takes
  minutes; its timeouts are 15 minutes per test.
- **`pnpm demo:p2p` fails** with `No projects matched the filters`: the root script filters
  `@statewalker/p2p-demo`, which is not a package of this workspace.
- **Tests stay green against a broken build.** Because tests read `src/`, a change that breaks the
  bundle or the declarations only shows up in `pnpm build`, `pnpm typecheck` or the
  consumer-install harness.
- **A dropped generator holds a stream open.** A caller of a `Duplex` must drain the returned
  generator or call `.return()` on it. An unreferenced generator sends no signal, so the peer waits
  for an acknowledgement that never comes and both sides keep the stream's slot.
- **`emulateMux` refuses a zero window.** A window of 0 would authorise the peer to send nothing,
  forever, so it throws `RangeError: emulateMux: maxStreamBuffer must be at least 1, got 0` at
  construction instead of deadlocking on the first call.

## Reference

### Commands

| Command | What it runs |
| --- | --- |
| `pnpm build` | `pnpm -r run build`: rolldown (tsdown for `webrun-http-events`) and declarations per package |
| `pnpm test` | `pnpm -r run test` (Vitest), including `tools/consumer-install` |
| `pnpm typecheck` | `pnpm -r run typecheck` in the packages that define it |
| `pnpm lint` / `pnpm lint:check` | `biome check --write .` / `biome check .` |
| `pnpm lint:fix`, `pnpm format:fix` | `biome check --write --unsafe .` |
| `pnpm format` / `pnpm format:check` | `biome format --write .` / `biome format .` |
| `pnpm changeset` | add a changeset to your pull request |

### Files

| Path | Role |
| --- | --- |
| `rolldown.preset.js` | `externalsFrom(import.meta.url)`: bundle externals from a package's manifest |
| `vitest.config.ts` | shared test config; aliases `@statewalker/webrun-*` to `src` |
| `tsconfig.base.json` | shared compiler options and `paths` to `src` |
| `biome.json` | lint and format rules |
| `CONTEXT.md` | glossary of the domain terms |
| `tools/consumer-install/` | pack-and-install harness for published manifests |

### CI and releases

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: a frozen install,
dependency-reference checks (`workspace:^` inside the repository, `catalog:` for everything else),
`lint:check`, `format:check`, build, typecheck, tests, and checks of export targets, dist imports
and packed manifests.

Packages are published to npm from CI with changesets. After CI passes on `main`, a job adds a
changeset for each package whose packed contents differ from npm and opens a
"chore: version packages" pull request; merging it publishes with provenance. To choose the bump or
the changelog text yourself, run `pnpm changeset` in your pull request. Renovate opens the
dependency updates. See [PUBLISHING.md](./PUBLISHING.md).

### License

MIT, see [LICENSE](./LICENSE).
