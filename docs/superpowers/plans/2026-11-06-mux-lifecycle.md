# Mux lifecycle: tie ports to their transport and their users (#39, part 1)

Goal: a `multiplexPort` frees its ports when its transport dies or when their user is done,
and a full table says who holds it. Wire format unchanged.

Out of scope (later, they change the wire): half-close (`end` envelope), keepalive ping/pong,
per-port credit, fair scheduling, dev-time `FinalizationRegistry` warnings.

Seam under test: the public `multiplexPort` / `overPipe` API over a real `MessageChannel`
(`tests/port-mux-lifecycle-signals.test.ts`). No mocks of the code under test.

## Tasks

1. **`close(reason)`** — `PortMux.close(reason?: unknown)`; each port's close signal aborts with
   `reason` when given, else `MUX_CLOSED_MESSAGE` as today. Also forwarded on `transferPortMux`
   (ignored there: real ports carry no signal).
   - Test: pending listener on `getPortCloseSignal(port)` sees the given reason.
2. **Transport `signal`** — `PortMuxOptions.signal` / `OverPipeOptions.signal`. Abort ⇒
   `mux.close(signal.reason)`; already-aborted ⇒ mux closed at construction (`openPort` throws).
   - Tests: abort ⇒ every port's signal aborts with the reason and `ports()` is empty; an
     in-flight `connect` call over `overPipe({ signal })` rejects; pre-aborted signal.
3. **`openPort(meta, { signal })`** — abort closes that port (peer gets `close`).
   - Test: abort frees the id on both ends.
4. **Disposable ports** — virtual ports get `[Symbol.dispose]` (where the runtime defines it)
   that calls `close()`; same helper style as `async-dispose.ts`.
   - Test: `using port = …` closes on scope exit (peer side sees close).
5. **Visibility** — `mux.ports(): Array<{ id, meta, openedAt, lastActivity }>` (optional on
   `PortMux`, implemented by `multiplexPort`), and the `maxPorts` `RangeError` names the three most
   common `meta.kind` values among the open ports.
   - Tests: `ports()` lists open ports with meta and drops closed ones; error text names the kind.
6. README + changeset (minor `webrun-rpc`).

Verify: `pnpm --filter @statewalker/webrun-rpc test`, `pnpm tsc --noEmit` in the package,
`pnpm biome check --write --unsafe`.
