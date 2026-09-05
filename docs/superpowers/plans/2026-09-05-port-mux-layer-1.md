# Port multiplexer, layer 1 (`webrun-ports`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `@statewalker/webrun-ports` package that turns one port into many virtual ports, with explicit lifecycle and no flow control of any kind.

**Architecture:** `PortMux` is an interface; this package ships the default implementation, which emulates multiplexing over a single `MessageTarget` by exchanging three envelope types (`open`, `message`, `close`). A `PortCodec` decides how an envelope reaches the wire, so the same multiplexer works over a structured-message port and (later, elsewhere) over a byte transport. Virtual ports are themselves `MessageTarget`s, which makes the multiplexer composable and makes a real `MessagePort` substitutable for a virtual one.

**Tech Stack:** TypeScript strict, ESM only, `moduleResolution: "Bundler"`, vitest, biome, rolldown, changesets.

**Spec:** `docs/superpowers/specs/2026-09-05-port-multiplexer-design.md` — read it first. This plan implements **Plan A** from its Sequencing section and nothing else.

## Global Constraints

- **`webrun-ports` has zero runtime dependencies.** Its only dependency is a **type-only** import of `MessageTarget`/`MessageListener` from `@statewalker/webrun-streams`. Nothing from that package may be imported at runtime — no value imports, no side-effecting imports.
- **Layer 1 has no flow control (D3).** No confirmation, no backpressure, no credit, no buffering ceiling. `postMessage` never blocks, never awaits, never applies credit.
- **Unaccepted and unread ports drop, never queue (D5).** Layer 1 holds no data on behalf of a consumer that does not exist. This is the invariant that makes D3 safe, and every case of it needs a test that fails without it.
- **`maxPorts` is not an exception to D3.** It bounds the id table only. Layer 1 may refuse to *create* a port; it may never hold back a message on one that exists.
- **This package implements no stream semantics.** No chunking, no acknowledgements, no half-close, no error serialisation. `close` carries an opaque `reason`; layer 1 never inspects it.
- ESM only (`"type": "module"`), TypeScript strict, `moduleResolution: "Bundler"`, relative imports carry a `.js` suffix.
- biome formatting: 2-space indent, line width 100, double quotes, semicolons always, trailing commas all. Use the **package-scoped** lint before each commit (`pnpm --filter @statewalker/webrun-ports lint`); the root `pnpm lint` exits 1 on a pre-existing baseline of 30 diagnostics and is not this plan's gate.
- Tests: vitest, files under `tests/`, named `*.test.ts`, run with `pnpm --filter @statewalker/webrun-ports test`.
- **Red/green TDD, observed.** Every behavioural step writes a failing test first and *runs it to watch it fail*. One step in this plan cannot have a red phase — Task 5's documentation — and it is labelled where it appears.
- **Standing rule, from six occurrences in this repository:** an assertion that is only an upper bound or an absence claim — "nothing was delivered", "no error", "the list is empty" — is satisfied by breaking the machinery outright. Every such assertion needs a floor next to it proving the mechanism still works. The drop-never-queue tests are especially exposed: "nothing arrived" is trivially true if nothing was ever sent.

## Repository and package rules

**Creating a package** requires, in the same change: the directory under `packages/` (the workspace glob `packages/*` already covers it, so `pnpm-workspace.yaml` needs no edit), a README following the house structure, a `tsconfig.json` extending `../../tsconfig.base.json`, a `rolldown.config.js` using `externalsFrom(import.meta.url)`, an entry in `tsconfig.base.json`'s `paths` map, a row in the root `README.md` package table, and a changeset. Task 1 creates the scaffolding; Task 5 completes the documentation and the changeset.

**Documentation moves with the code.** A package README documents its export surface. Any task that adds a public export updates the README in the same commit.

## What this plan does not do

- **No adapter is modified and nothing is deleted.** `emulateMux`, `ByteChannel`, `webrun-streams-port` and all six transport adapters are untouched. Deletion happens in Plan C.
- **No `msgpackCodec`.** It lands in `webrun-msgpack` (spec Packaging), because `webrun-ports` must stay dependency-free. Only `structuredCodec` ships here.
- **No layer 2.** No `duplexOverPort`, no stream protocol, no `callPort` changes. Plan B.
- **No transport-death detection.** A `MessageTarget` has no close event, so this multiplexer cannot notice its underlying port dying. Closing it is the owner's job via `mux.close()`. Layer 2 and the adapters wire that up in Plan B/C; do not invent a heartbeat here.

## File Structure

**Create**
- `packages/webrun-ports/package.json` — manifest; no `dependencies` block beyond the type-only one.
- `packages/webrun-ports/tsconfig.json` — extends the base config.
- `packages/webrun-ports/rolldown.config.js` — single ESM bundle.
- `packages/webrun-ports/README.md` — house structure.
- `packages/webrun-ports/src/index.ts` — the barrel.
- `packages/webrun-ports/src/types.ts` — `PortEnvelope`, `PortCodec`, `PortMux`, `PortMuxOptions`. Types only, no logic.
- `packages/webrun-ports/src/structured-codec.ts` — the passthrough codec and its envelope guard.
- `packages/webrun-ports/src/virtual-port.ts` — one virtual port: listener set, local close state, delivery.
- `packages/webrun-ports/src/multiplex-port.ts` — the default `PortMux` implementation.
- `packages/webrun-ports/tests/structured-codec.test.ts`
- `packages/webrun-ports/tests/multiplex-port.test.ts`
- `packages/webrun-ports/tests/invariants.test.ts`
- `.changeset/<generated>.md` — release note (Task 5).

**Modify**
- `tsconfig.base.json` — one `paths` entry.
- `README.md` (root) — one package-table row.

---

### Task 1: Package scaffolding, envelope types, and the structured codec

**Files:**
- Create: `packages/webrun-ports/package.json`, `tsconfig.json`, `rolldown.config.js`, `src/types.ts`, `src/structured-codec.ts`, `src/index.ts`
- Create: `packages/webrun-ports/tests/structured-codec.test.ts`
- Modify: `tsconfig.base.json`

**Interfaces:**
- Consumes: `MessageTarget`, `MessageListener` from `@statewalker/webrun-streams`, **type-only**.
- Produces: `PortEnvelope`, `PortCodec`, `PortMux`, `PortMuxOptions` (types); `structuredCodec: PortCodec`. Later tasks import all of these.

- [ ] **Step 1: Create the package manifest**

Create `packages/webrun-ports/package.json`:

```json
{
  "name": "@statewalker/webrun-ports",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "Turn one message port into many. Explicit port lifecycle, pluggable codec, no flow control.",
  "homepage": "https://github.com/statewalker/webrun-wire",
  "author": {
    "name": "Mikhail Kotelnikov",
    "email": "mikhail.kotelnikov@gmail.com"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git@github.com:statewalker/webrun-wire.git",
    "directory": "packages/webrun-ports"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "src"
  ],
  "scripts": {
    "build": "rimraf dist && rolldown -c && tsc --emitDeclarationOnly --declaration",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rimraf dist",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/webrun-streams": "workspace:*"
  },
  "devDependencies": {
    "rimraf": "catalog:",
    "rolldown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": {
    "access": "public"
  },
  "types": "./dist/index.d.ts"
}
```

`@statewalker/webrun-streams` appears under `dependencies` because the published `.d.ts` refers to its types. It is **never imported at runtime** — Task 1 Step 9 verifies that mechanically.

- [ ] **Step 2: Create the TypeScript and bundler configs**

Create `packages/webrun-ports/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["src"]
}
```

Create `packages/webrun-ports/rolldown.config.js`:

```js
import { defineConfig } from "rolldown";
import { externalsFrom } from "../../rolldown.preset.js";

// Single ESM bundle at dist/index.js. Everything this package declares as a
// dependency or peer dependency stays external — see ../../rolldown.preset.js.
export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  treeshake: true,
  external: externalsFrom(import.meta.url),
});
```

Add to `tsconfig.base.json`'s `compilerOptions.paths`, keeping the map alphabetical:

```json
    "@statewalker/webrun-ports": ["./packages/webrun-ports/src"],
```

- [ ] **Step 3: Link the new package into the workspace**

A package that pnpm has never installed has no `node_modules`, so `vitest`,
`typescript`, `rimraf` and `rolldown` are not resolvable inside it and every
later step fails at the shell rather than at an assertion.

```bash
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev && pnpm install
```

Run it from the **assembly root** (`worktrees/dev/`), not from the umbrella root
and not from this package. The umbrella root's `pnpm-workspace.yaml` globs
`workspaces/*`, a directory that does not exist there, so an install run from it
is a silent no-op. The assembly's `pnpm-lock.yaml` is gitignored, so this
changes no tracked file.

Verify the link before continuing:

```bash
ls /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/workspaces/webrun-wire/packages/webrun-ports/node_modules/.bin/vitest
```

Expected: the path exists. If it does not, the package was not picked up — check
that `package.json` is valid JSON and that the directory sits directly under
`packages/`.

- [ ] **Step 4: Write the failing codec test**

Create `packages/webrun-ports/tests/structured-codec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { structuredCodec } from "../src/structured-codec.js";
import type { PortEnvelope } from "../src/types.js";

/** A MessageTarget stub that records what was posted. */
function recordingPort() {
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  return {
    posted,
    port: {
      addEventListener() {},
      removeEventListener() {},
      postMessage(message: unknown, transfer?: Transferable[]) {
        posted.push({ message, transfer });
      },
    },
  };
}

const asEvent = (data: unknown): MessageEvent => new MessageEvent("message", { data });

describe("structuredCodec", () => {
  it("posts the envelope unchanged, without encoding it", () => {
    const { port, posted } = recordingPort();
    const envelope: PortEnvelope = { type: "message", id: 4, payload: { hello: "world" } };
    structuredCodec.post(port, envelope);
    expect(posted).toHaveLength(1);
    // Identity, not deep equality: the whole point is that nothing is encoded.
    expect(posted[0]?.message).toBe(envelope);
  });

  it("forwards a transfer list so ArrayBuffers move zero-copy", () => {
    const { port, posted } = recordingPort();
    const buffer = new ArrayBuffer(8);
    structuredCodec.post(port, { type: "message", id: 2, payload: buffer }, [buffer]);
    expect(posted[0]?.transfer).toEqual([buffer]);
  });

  it("omits the transfer argument entirely when there is nothing to transfer", () => {
    const { port, posted } = recordingPort();
    structuredCodec.post(port, { type: "message", id: 2, payload: 1 }, []);
    // An empty array is not the same as absent: some MessageTarget
    // implementations reject an empty transfer list.
    expect(posted[0]?.transfer).toBeUndefined();
  });

  it("reads back each envelope type", () => {
    expect(structuredCodec.read(asEvent({ type: "open", id: 0 }))).toEqual({ type: "open", id: 0 });
    expect(structuredCodec.read(asEvent({ type: "message", id: 1, payload: "x" }))).toEqual({
      type: "message",
      id: 1,
      payload: "x",
    });
    expect(structuredCodec.read(asEvent({ type: "close", id: 2, reason: "why" }))).toEqual({
      type: "close",
      id: 2,
      reason: "why",
    });
  });

  it("ignores traffic that is not an envelope", () => {
    // A port may legitimately carry other people's messages. Claiming them
    // would corrupt an application that shares the transport.
    expect(structuredCodec.read(asEvent(undefined))).toBeUndefined();
    expect(structuredCodec.read(asEvent(null))).toBeUndefined();
    expect(structuredCodec.read(asEvent("hello"))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message" }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "nope", id: 0 }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message", id: -1 }))).toBeUndefined();
    expect(structuredCodec.read(asEvent({ type: "message", id: 1.5 }))).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/structured-codec.test.ts
```

Expected: **exit 1, a startup error, and `Tests  no tests`** — not a failed assertion, because the module does not exist yet:

```
 FAIL  tests/structured-codec.test.ts [ tests/structured-codec.test.ts ]
Error: Cannot find module '../src/structured-codec.js' imported from <repo>/packages/webrun-ports/tests/structured-codec.test.ts
```

- [ ] **Step 6: Write the types**

Create `packages/webrun-ports/src/types.ts`:

```ts
import type { MessageTarget } from "@statewalker/webrun-streams";

/**
 * What a multiplexer exchanges over the underlying port.
 *
 * Three types and nothing more. There is no DATA/ACK split, no credit and no
 * error type: `close` carries an opaque `reason` that layer 1 never inspects,
 * because stream semantics belong above this layer.
 */
export type PortEnvelope =
  | { type: "open"; id: number; meta?: unknown }
  | { type: "message"; id: number; payload: unknown }
  | { type: "close"; id: number; reason?: unknown };

/**
 * How an envelope reaches the wire.
 *
 * This is the only place that knows the wire format. A port whose messages are
 * structured values passes envelopes through untouched; a port whose messages
 * are bytes encodes them. A transport with different constraints adds a codec,
 * not a multiplexer.
 */
export interface PortCodec {
  /** Place one envelope on the underlying port. */
  post(port: MessageTarget, envelope: PortEnvelope, transfer?: Transferable[]): void;
  /** Recover an envelope from a message event, or `undefined` to ignore it. */
  read(event: MessageEvent): PortEnvelope | undefined;
}

export interface PortMuxOptions {
  /** How envelopes are placed on the underlying port. */
  codec: PortCodec;
  /**
   * Called when the peer opens a port. Return `false` to reject it: a `close`
   * goes back and every later message for that id is dropped. Any other return
   * value — including `undefined` — accepts.
   *
   * With no `onPort` at all, inbound ports are rejected. A port nobody holds
   * has no consumer, and accepting one would mean dropping its traffic
   * silently rather than telling the peer.
   */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined;
  /**
   * Id parity. The initiator allocates even ids, the responder odd, so both
   * ends may open concurrently with no negotiation. Defaults to `"initiator"`.
   */
  side?: "initiator" | "responder";
  /**
   * Ceiling on concurrently open virtual ports. Bounds the id table only — it
   * never inspects, counts or delays a payload.
   */
  maxPorts?: number;
  /**
   * Largest message this mux's ports can carry, if the transport imposes one.
   * Layer 1 does not enforce it; it reports it so layer 2 can chunk to fit.
   */
  maxMessageSize?: number;
}

/** One port in, many ports out. */
export interface PortMux {
  /** Allocate a port, announce it, and return the local end immediately. */
  openPort(meta?: unknown): MessageTarget;
  /** Close every virtual port, then release the underlying port. */
  close(): Promise<void>;
  /** See {@link PortMuxOptions.maxMessageSize}. */
  readonly maxMessageSize?: number;
}
```

- [ ] **Step 7: Write the codec**

Create `packages/webrun-ports/src/structured-codec.ts`:

```ts
import type { PortCodec, PortEnvelope } from "./types.js";

function isEnvelope(value: unknown): value is PortEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  if (typeof candidate.id !== "number") return false;
  if (!Number.isInteger(candidate.id) || candidate.id < 0) return false;
  return candidate.type === "open" || candidate.type === "message" || candidate.type === "close";
}

/**
 * For ports whose messages are structured values — a real `MessagePort`, a
 * worker, an iframe.
 *
 * Envelopes are posted as-is, so nothing is encoded, `ArrayBuffer`s move
 * zero-copy through the transfer list, and structured clone does the work the
 * platform already does well. This is a performance choice only: layer 2 may
 * not send anything a byte codec could not also carry.
 */
export const structuredCodec: PortCodec = {
  post(port, envelope, transfer) {
    // An empty transfer list is not the same as no transfer list — some
    // implementations reject the former.
    if (transfer && transfer.length > 0) port.postMessage(envelope, transfer);
    else port.postMessage(envelope);
  },
  read(event) {
    return isEnvelope(event.data) ? event.data : undefined;
  },
};
```

Create `packages/webrun-ports/src/index.ts`:

```ts
export { structuredCodec } from "./structured-codec.js";
export type { PortCodec, PortEnvelope, PortMux, PortMuxOptions } from "./types.js";
```

- [ ] **Step 8: Run and verify green**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/structured-codec.test.ts
```

Expected: 5 tests passing.

- [ ] **Step 9: Verify the type-only dependency mechanically**

The zero-runtime-dependency claim must be checked, not asserted:

```bash
pnpm --filter @statewalker/webrun-ports build
grep -c "webrun-streams" packages/webrun-ports/dist/index.js
```

Expected: `0`. The bundle must contain no reference to `@statewalker/webrun-streams`, because every import of it is a `import type` that TypeScript erases. If this prints anything other than `0`, a value import crept in — find it before continuing.

- [ ] **Step 10: Lint, typecheck and commit**

```bash
pnpm --filter @statewalker/webrun-ports lint
pnpm --filter @statewalker/webrun-ports typecheck
git add packages/webrun-ports tsconfig.base.json
git commit -m "feat(ports): package scaffolding, envelope types and the structured codec

Three envelope types and nothing more: open, message, close. Close carries an
opaque reason rather than a serialized error, because stream semantics belong
above layer 1.

structuredCodec passes envelopes through unencoded and forwards a transfer
list, so ArrayBuffers move zero-copy on a real MessagePort. It ignores traffic
that is not an envelope, so an application sharing the transport is not
corrupted.

The dependency on webrun-streams is type-only and the built bundle is checked
for it."
```

Expected: both commands exit 0.

---

### Task 2: The virtual port

**Files:**
- Create: `packages/webrun-ports/src/virtual-port.ts`
- Create: `packages/webrun-ports/tests/virtual-port.test.ts`

**Interfaces:**
- Consumes: `MessageTarget`, `MessageListener` from `@statewalker/webrun-streams` (type-only).
- Produces: `newVirtualPort(send, requestClose): VirtualPortHandle`, where `VirtualPortHandle` is `{ port: MessageTarget; deliver(payload: unknown): void; markClosed(): void; isClosed(): boolean }`. Task 3 wires this into the multiplexer.

The split exists because a virtual port has two audiences: the consumer holds `port` and sees only a `MessageTarget`, while the multiplexer holds the handle and can deliver into it and close it. Keeping `deliver` off the public `MessageTarget` is what stops a consumer from forging inbound traffic.

- [ ] **Step 1: Write the failing test**

Create `packages/webrun-ports/tests/virtual-port.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { newVirtualPort } from "../src/virtual-port.js";

describe("virtual port", () => {
  it("forwards postMessage to its send function, transfer list included", () => {
    const send = vi.fn();
    const { port } = newVirtualPort(send, () => {});
    const buffer = new ArrayBuffer(4);
    port.postMessage({ a: 1 }, [buffer]);
    expect(send).toHaveBeenCalledWith({ a: 1 }, [buffer]);
  });

  it("delivers inbound payloads to every registered listener", () => {
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    port.addEventListener("message", (event) => seen.push(event.data));
    port.addEventListener("message", (event) => seen.push(event.data));
    deliver("hello");
    expect(seen).toEqual(["hello", "hello"]);
  });

  it("stops delivering to a removed listener but keeps the others", () => {
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const kept: unknown[] = [];
    const dropped: unknown[] = [];
    const keptListener = (event: MessageEvent) => kept.push(event.data);
    const droppedListener = (event: MessageEvent) => dropped.push(event.data);
    port.addEventListener("message", keptListener);
    port.addEventListener("message", droppedListener);
    port.removeEventListener("message", droppedListener);
    deliver(1);
    // Floor as well as ceiling: the kept listener proves delivery still works,
    // so an empty `dropped` is evidence rather than an accident.
    expect(kept).toEqual([1]);
    expect(dropped).toEqual([]);
  });

  it("asks the multiplexer to close, exactly once", () => {
    const requestClose = vi.fn();
    const { port } = newVirtualPort(() => {}, requestClose);
    port.close?.();
    port.close?.();
    expect(requestClose).toHaveBeenCalledTimes(1);
  });

  it("ignores posts and deliveries once closed", () => {
    const send = vi.fn();
    const { port, deliver, markClosed } = newVirtualPort(send, () => {});
    const seen: unknown[] = [];
    port.addEventListener("message", (event) => seen.push(event.data));

    deliver("before");
    port.postMessage("out");
    markClosed();
    deliver("after");
    port.postMessage("out-after");

    expect(seen).toEqual(["before"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("out", undefined);
  });

  it("survives a listener that throws", () => {
    // One bad consumer must not stop the others from seeing the message, and
    // must not take down the multiplexer's inbound loop.
    const { port, deliver } = newVirtualPort(
      () => {},
      () => {},
    );
    const seen: unknown[] = [];
    port.addEventListener("message", () => {
      throw new Error("listener blew up");
    });
    port.addEventListener("message", (event) => seen.push(event.data));
    expect(() => deliver("x")).not.toThrow();
    expect(seen).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/virtual-port.test.ts
```

Expected: exit 1, `Cannot find module '../src/virtual-port.js'`, `Tests  no tests`.

- [ ] **Step 3: Implement the virtual port**

Create `packages/webrun-ports/src/virtual-port.ts`:

```ts
import type { MessageListener, MessageTarget } from "@statewalker/webrun-streams";

export interface VirtualPortHandle {
  /** The consumer-facing end. Indistinguishable from a real `MessagePort`. */
  port: MessageTarget;
  /** Multiplexer-only: hand an inbound payload to the consumer's listeners. */
  deliver(payload: unknown): void;
  /** Multiplexer-only: the port is finished; drop listeners and go inert. */
  markClosed(): void;
  isClosed(): boolean;
}

/**
 * One virtual port.
 *
 * `deliver` and `markClosed` are deliberately not on `port`: the consumer holds
 * only a `MessageTarget`, so it cannot forge inbound traffic or close the port
 * out from under the multiplexer's bookkeeping.
 */
export function newVirtualPort(
  send: (payload: unknown, transfer?: Transferable[]) => void,
  requestClose: (reason?: unknown) => void,
): VirtualPortHandle {
  const listeners = new Set<MessageListener>();
  let closed = false;

  const port: MessageTarget = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    postMessage(message, transfer) {
      if (closed) return;
      send(message, transfer);
    },
    close() {
      if (closed) return;
      closed = true;
      const notify = requestClose;
      listeners.clear();
      notify();
    },
  };

  return {
    port,
    deliver(payload) {
      if (closed) return;
      const event = new MessageEvent("message", { data: payload });
      // Copy first: a listener may add or remove listeners while running.
      for (const listener of [...listeners]) {
        try {
          void listener(event);
        } catch {
          // One consumer's fault is not the multiplexer's. Swallowing here
          // keeps a thrown listener from killing the inbound loop and every
          // other port with it.
        }
      }
    },
    markClosed() {
      closed = true;
      listeners.clear();
    },
    isClosed() {
      return closed;
    },
  };
}
```

- [ ] **Step 4: Run and verify green**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/virtual-port.test.ts
pnpm --filter @statewalker/webrun-ports test
```

Expected: 6 tests in the new file; 11 in the package.

- [ ] **Step 5: Prove the tests are not vacuous**

Apply each mutation to `src/virtual-port.ts`, run `pnpm --filter @statewalker/webrun-ports test`, record the measured output, then revert with `git checkout -- packages/webrun-ports/src/virtual-port.ts`. **Never `git checkout -- <directory>`.**

| mutation | expected to turn red |
| --- | --- |
| drop the `if (closed) return;` guard in `deliver` | `ignores posts and deliveries once closed` |
| drop the `if (closed) return;` guard in `postMessage` | `ignores posts and deliveries once closed` |
| remove the `try`/`catch` around `listener(event)` | `survives a listener that throws` |
| iterate `listeners` directly instead of `[...listeners]` | nothing — see below |

The last row is expected to stay **green**, and that is information, not a gap: no test currently mutates the listener set during delivery. Record it as a known uncovered case rather than inventing a test for it; layer 2 does not do this, and a test written only to justify a defensive copy would be pinning the implementation rather than a behaviour.

- [ ] **Step 6: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-ports lint
git add packages/webrun-ports/src/virtual-port.ts packages/webrun-ports/tests/virtual-port.test.ts
git commit -m "feat(ports): the virtual port

deliver() and markClosed() are kept off the consumer-facing MessageTarget, so a
consumer cannot forge inbound traffic or close the port behind the
multiplexer's bookkeeping.

A throwing listener is contained: without the catch, one bad consumer would
take down the inbound loop and every other port sharing the transport."
```

---

### Task 3: `multiplexPort` — open, accept, reject, deliver

**Files:**
- Create: `packages/webrun-ports/src/multiplex-port.ts`
- Create: `packages/webrun-ports/tests/multiplex-port.test.ts`
- Modify: `packages/webrun-ports/src/index.ts`

**Interfaces:**
- Consumes: `newVirtualPort`/`VirtualPortHandle` (Task 2); `PortMux`, `PortMuxOptions`, `PortEnvelope` (Task 1).
- Produces: `multiplexPort(port: MessageTarget, options: PortMuxOptions): PortMux` and `DEFAULT_MAX_PORTS = 1024`.

Tests use a **real `MessageChannel`**, not a stub. Node provides `MessageChannel`/`MessagePort` as globals, and a `MessagePort` satisfies `MessageTarget` structurally — spec F1, verified in commit `5dd9704`. Testing against the real thing is what keeps that claim honest. Delivery is asynchronous, so tests await a macrotask tick.

- [ ] **Step 1: Write the failing test**

Create `packages/webrun-ports/tests/multiplex-port.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { multiplexPort } from "../src/multiplex-port.js";
import { structuredCodec } from "../src/structured-codec.js";
import type { PortMux } from "../src/types.js";

/** Real MessagePorts: a MessagePort satisfies MessageTarget structurally. */
function newChannel() {
  const channel = new MessageChannel();
  return { a: channel.port1, b: channel.port2 };
}

/** MessagePort delivery is a macrotask; give it one. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const muxes: PortMux[] = [];
function track<T extends PortMux>(mux: T): T {
  muxes.push(mux);
  return mux;
}

afterEach(async () => {
  // A live MessagePort keeps the Node process alive.
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
});

describe("multiplexPort", () => {
  it("delivers a message from an opened port to the accepting peer", async () => {
    const { a, b } = newChannel();
    const received: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => received.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, side: "initiator" }));

    const port = client.openPort();
    port.postMessage("ping");
    await tick();

    expect(received).toEqual(["ping"]);
  });

  it("hands the opener's meta to onPort", async () => {
    const { a, b } = newChannel();
    let seen: unknown = "not called";
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (_port, meta) => {
          seen = meta;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    client.openPort({ kind: "stream" });
    await tick();

    expect(seen).toEqual({ kind: "stream" });
  });

  it("carries traffic in both directions on one virtual port", async () => {
    const { a, b } = newChannel();
    const atServer: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => {
            atServer.push(event.data);
            port.postMessage(`echo:${String(event.data)}`);
          });
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    const atClient: unknown[] = [];
    port.addEventListener("message", (event) => atClient.push(event.data));
    port.postMessage("one");
    await tick();
    await tick();

    expect(atServer).toEqual(["one"]);
    expect(atClient).toEqual(["echo:one"]);
  });

  it("allocates even ids for the initiator and odd for the responder", async () => {
    const { a, b } = newChannel();
    const ids: number[] = [];
    // Watch the raw wire rather than the API, so the parity rule is pinned
    // where a peer implementation would actually observe it.
    b.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "open") ids.push(envelope.id);
    });
    b.start();
    const client = track(multiplexPort(a, { codec: structuredCodec, side: "initiator" }));
    client.openPort();
    client.openPort();
    await tick();
    expect(ids).toEqual([0, 2]);

    const { a: c, b: d } = newChannel();
    const otherIds: number[] = [];
    d.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "open") otherIds.push(envelope.id);
    });
    d.start();
    const server = track(multiplexPort(c, { codec: structuredCodec, side: "responder" }));
    server.openPort();
    server.openPort();
    await tick();
    expect(otherIds).toEqual([1, 3]);
  });

  it("rejects an inbound port when onPort returns false, and closes the opener's end", async () => {
    const { a, b } = newChannel();
    const delivered: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => delivered.push(event.data));
          return false;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    port.postMessage("before-rejection");
    await tick();
    await tick();

    // Ceiling: nothing reached the rejected port's listener.
    expect(delivered).toEqual([]);

    // Floor: the rejection reached the opener and made its end inert. Watching
    // the raw wire is what distinguishes "the peer closed us" from "nothing
    // ever ran" — the second post produces no envelope at all.
    let messagesOnWire = 0;
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") messagesOnWire++;
    });
    port.postMessage("after-rejection");
    await tick();
    expect(messagesOnWire).toBe(0);
  });

  it("rejects inbound ports when there is no onPort at all", async () => {
    const { a, b } = newChannel();
    // A responder that never accepts: a port nobody holds has no consumer.
    const closes: number[] = [];
    a.addEventListener("message", (event) => {
      const envelope = structuredCodec.read(event);
      if (envelope?.type === "close") closes.push(envelope.id);
    });
    track(multiplexPort(b, { codec: structuredCodec, side: "responder" }));
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    client.openPort();
    await tick();
    await tick();

    expect(closes).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/multiplex-port.test.ts
```

Expected: exit 1, `Cannot find module '../src/multiplex-port.js'`, `Tests  no tests`.

- [ ] **Step 3: Implement the multiplexer**

Create `packages/webrun-ports/src/multiplex-port.ts`:

```ts
import type { MessageTarget } from "@statewalker/webrun-streams";
import type { PortEnvelope, PortMux, PortMuxOptions } from "./types.js";
import { newVirtualPort, type VirtualPortHandle } from "./virtual-port.js";

/** Ceiling on concurrently open virtual ports. Bounds the id table only. */
export const DEFAULT_MAX_PORTS = 1024;

/**
 * The default `PortMux`: emulates multiplexing over a single port.
 *
 * A transport that already multiplexes natively supplies its own `PortMux`
 * instead — this implementation is for transports that offer one pipe.
 */
export function multiplexPort(port: MessageTarget, options: PortMuxOptions): PortMux {
  const { codec, onPort, side = "initiator", maxPorts = DEFAULT_MAX_PORTS, maxMessageSize } = options;

  const open = new Map<number, VirtualPortHandle>();
  let nextId = side === "initiator" ? 0 : 1;
  let muxClosed = false;

  const post = (envelope: PortEnvelope, transfer?: Transferable[]): void => {
    if (muxClosed) return;
    try {
      codec.post(port, envelope, transfer);
    } catch {
      // The underlying port is gone. There is nothing useful to do here and
      // no flow control to unwind — layer 1 holds no state on its behalf.
    }
  };

  const attach = (id: number): VirtualPortHandle => {
    let self!: VirtualPortHandle;
    self = newVirtualPort(
      (payload, transfer) => post({ type: "message", id, payload }, transfer),
      (reason) => {
        post({ type: "close", id, reason });
        open.delete(id);
        self.markClosed();
      },
    );
    open.set(id, self);
    return self;
  };

  const handleEnvelope = (envelope: PortEnvelope): void => {
    if (muxClosed) return;

    if (envelope.type === "open") {
      // A duplicate id is a peer bug; ignoring it is safer than replacing a
      // live port out from under its consumer.
      if (open.has(envelope.id)) return;
      if (open.size >= maxPorts) {
        post({ type: "close", id: envelope.id, reason: "max-ports" });
        return;
      }
      const handle = attach(envelope.id);
      let accepted = false;
      if (onPort) {
        try {
          accepted = onPort(handle.port, envelope.meta) !== false;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) {
        open.delete(envelope.id);
        handle.markClosed();
        post({ type: "close", id: envelope.id, reason: "rejected" });
      }
      return;
    }

    const handle = open.get(envelope.id);

    if (envelope.type === "message") {
      // Drop, never queue. An id that was rejected, never opened, or already
      // closed has no consumer, and holding its traffic would be exactly the
      // buffering layer 1 refuses to do.
      if (!handle) return;
      handle.deliver(envelope.payload);
      return;
    }

    if (!handle) return;
    open.delete(envelope.id);
    handle.markClosed();
  };

  const listener = (event: MessageEvent): void => {
    const envelope = codec.read(event);
    if (envelope) handleEnvelope(envelope);
  };

  port.addEventListener("message", listener);
  void port.start?.();

  return {
    maxMessageSize,

    openPort(meta?: unknown): MessageTarget {
      if (muxClosed) throw new Error("webrun-ports: the multiplexer is closed");
      if (open.size >= maxPorts) {
        throw new RangeError(`webrun-ports: maxPorts (${maxPorts}) reached`);
      }
      const id = nextId;
      nextId += 2;
      const handle = attach(id);
      post({ type: "open", id, meta });
      return handle.port;
    },

    async close(): Promise<void> {
      if (muxClosed) return;
      for (const [id, handle] of [...open]) {
        post({ type: "close", id });
        open.delete(id);
        handle.markClosed();
      }
      muxClosed = true;
      port.removeEventListener("message", listener);
      await port.close?.();
    },
  };
}
```

- [ ] **Step 4: Export it**

Modify `packages/webrun-ports/src/index.ts` to:

```ts
export { DEFAULT_MAX_PORTS, multiplexPort } from "./multiplex-port.js";
export { structuredCodec } from "./structured-codec.js";
export type { PortCodec, PortEnvelope, PortMux, PortMuxOptions } from "./types.js";
```

`virtual-port.js` is deliberately **not** exported. `VirtualPortHandle` exposes `deliver` and `markClosed`, which are the multiplexer's private levers; publishing them would let a consumer forge inbound traffic.

- [ ] **Step 5: Run and verify green**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/multiplex-port.test.ts
pnpm --filter @statewalker/webrun-ports test
```

Expected: 6 tests in the new file; 17 in the package.

- [ ] **Step 6: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-ports lint
git add packages/webrun-ports/src packages/webrun-ports/tests/multiplex-port.test.ts
git commit -m "feat(ports): multiplexPort — open, accept, reject, deliver

Ids are even for the initiator and odd for the responder, so both ends may open
concurrently with no negotiation. That rule is pinned on the raw wire rather
than through the API, because that is where a peer implementation observes it.

An inbound port with no onPort is rejected rather than accepted: a port nobody
holds has no consumer, and accepting it would drop its traffic silently instead
of telling the peer.

Tests run against a real MessageChannel, which is also a standing check that a
MessagePort satisfies MessageTarget structurally."
```

---

### Task 4: Invariants — drop, isolation, ordering, close and limits

**Files:**
- Create: `packages/webrun-ports/tests/invariants.test.ts`
- Modify: `packages/webrun-ports/src/multiplex-port.ts` (only if an invariant test exposes a gap)

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces nothing new.

This task is where the spec's layer-1 guarantees become executable. Each invariant needs a test that fails without it — that is the point of the task, not a formality.

- [ ] **Step 1: Write the failing invariant tests**

Create `packages/webrun-ports/tests/invariants.test.ts`:

```ts
import type { MessageTarget } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { multiplexPort } from "../src/multiplex-port.js";
import { structuredCodec } from "../src/structured-codec.js";
import type { PortMux } from "../src/types.js";

function newChannel() {
  const channel = new MessageChannel();
  return { a: channel.port1, b: channel.port2 };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const muxes: PortMux[] = [];
function track<T extends PortMux>(mux: T): T {
  muxes.push(mux);
  return mux;
}

afterEach(async () => {
  await Promise.allSettled(muxes.splice(0).map((mux) => mux.close()));
});

describe("layer 1 invariants", () => {
  it("drops a message for an unknown id, and does not conjure a port for it", async () => {
    const { a, b } = newChannel();
    const opened: unknown[] = [];
    const accepted: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port, meta) => {
          opened.push(meta);
          port.addEventListener("message", (event) => accepted.push(event.data));
        },
      }),
    );

    // Forge traffic for an id that was never opened.
    a.postMessage({ type: "message", id: 40, payload: "ghost" });
    a.start();
    await tick();

    // Then open a real port and send on it.
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    const port = client.openPort("real-port");
    port.postMessage("real");
    await tick();
    await tick();

    // Ceiling: the forged id produced no port at all. An implementation that
    // queued the message, or attached a port on first sight of an id, would
    // announce it here.
    expect(opened).toEqual(["real-port"]);
    // Floor: a genuine message still arrives, so the absence above is evidence
    // rather than an artefact of nothing having run.
    expect(accepted).toEqual(["real"]);
  });

  it("drops messages for a port the peer already closed", async () => {
    const { a, b } = newChannel();
    const seen: unknown[] = [];
    let serverPort: { close?: () => void } | undefined;
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          serverPort = port;
          port.addEventListener("message", (event) => seen.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    port.postMessage("before");
    await tick();
    serverPort?.close?.();
    await tick();
    port.postMessage("after");
    await tick();

    expect(seen).toEqual(["before"]);
  });

  it("keeps ports isolated: one closing does not disturb another", async () => {
    const { a, b } = newChannel();
    const perPort = new Map<unknown, unknown[]>();
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port, meta) => {
          const log: unknown[] = [];
          perPort.set(meta, log);
          port.addEventListener("message", (event) => log.push(event.data));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const first = client.openPort("first");
    const second = client.openPort("second");
    await tick();

    first.postMessage(1);
    second.postMessage(2);
    await tick();

    first.close?.();
    await tick();

    second.postMessage(3);
    await tick();

    expect(perPort.get("first")).toEqual([1]);
    expect(perPort.get("second")).toEqual([2, 3]);
  });

  it("preserves ordering within a port", async () => {
    const { a, b } = newChannel();
    const seen: number[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => seen.push(event.data as number));
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));

    const port = client.openPort();
    for (let i = 0; i < 50; i++) port.postMessage(i);
    await tick();
    await tick();

    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("closes both ends when either closes, and is idempotent", async () => {
    const { a, b } = newChannel();
    let serverPort: MessageTarget | undefined;
    // Watch the responder's own outbound wire: it is the only place that
    // distinguishes "the far end went inert" from "the near end stopped
    // listening", and the two look identical from the client's side.
    let serverMessages = 0;
    let clientCloses = 0;
    b.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "close") clientCloses++;
    });
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          serverPort = port;
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec }));
    a.addEventListener("message", (event) => {
      if (structuredCodec.read(event)?.type === "message") serverMessages++;
    });

    const port = client.openPort();
    await tick();

    // Floor: before the close, the responder's end genuinely works.
    serverPort?.postMessage("before-close");
    await tick();
    expect(serverMessages).toBe(1);

    port.close?.();
    port.close?.();
    await tick();

    // Ceiling: the close reached the responder and made its end inert, so this
    // post never becomes an envelope.
    serverPort?.postMessage("after-close");
    await tick();
    expect(serverMessages).toBe(1);

    // Idempotent: two local closes put exactly one close on the wire.
    expect(clientCloses).toBe(1);
  });

  it("refuses to open beyond maxPorts, and rejects an inbound OPEN beyond it", async () => {
    const { a, b } = newChannel();
    const acceptedIds: unknown[] = [];
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        maxPorts: 2,
        onPort: (_port, meta) => {
          acceptedIds.push(meta);
        },
      }),
    );
    const client = track(multiplexPort(a, { codec: structuredCodec, maxPorts: 2 }));

    client.openPort("one");
    client.openPort("two");
    expect(() => client.openPort("three")).toThrow(RangeError);
    await tick();

    expect(acceptedIds).toEqual(["one", "two"]);
  });

  it("composes: a multiplexer over a virtual port yields more ports", async () => {
    const { a, b } = newChannel();

    // Outer layer.
    let innerServerSide: MessageTarget | undefined;
    track(
      multiplexPort(b, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          innerServerSide = port;
        },
      }),
    );
    const outerClient = track(multiplexPort(a, { codec: structuredCodec }));
    const carrier = outerClient.openPort();
    await tick();

    // Inner layer, riding on one virtual port of the outer one.
    const seen: unknown[] = [];
    if (!innerServerSide) throw new Error("outer port was never accepted");
    track(
      multiplexPort(innerServerSide, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          port.addEventListener("message", (event) => seen.push(event.data));
        },
      }),
    );
    const innerClient = track(multiplexPort(carrier, { codec: structuredCodec }));
    const innerPort = innerClient.openPort();
    innerPort.postMessage("through two layers");
    await tick();
    await tick();

    expect(seen).toEqual(["through two layers"]);
  });
});
```

- [ ] **Step 2: Run them**

```bash
pnpm --filter @statewalker/webrun-ports exec vitest run tests/invariants.test.ts
```

Expected: **all 7 pass**, because Task 3's implementation already satisfies them. This is a characterization step, not a TDD cycle — the invariants were designed into the implementation, and this task's job is to make them executable and prove they can fail. Do not manufacture a red phase by breaking the implementation first. Step 3 is what establishes these tests are worth having.

If any test fails, that is a genuine gap in Task 3 — fix `multiplex-port.ts`, and say so in the report rather than adjusting the test.

- [ ] **Step 3: Prove every invariant test can fail**

Apply each mutation to `packages/webrun-ports/src/multiplex-port.ts`, run `pnpm --filter @statewalker/webrun-ports test`, record the measured red set, then revert with `git checkout -- packages/webrun-ports/src/multiplex-port.ts`.

**These are predictions, not measurements.** Record what you actually observe beside each row and
report any discrepancy rather than adjusting a test to make a row come true. A mutation table in
this repository has been wrong before, and the cost of trusting one is a test that looks load-bearing
and is not.

| # | mutation | predicted red |
| --- | --- | --- |
| 1 | in `handleEnvelope`'s `open` branch, attach and announce a port for an unknown id in the `message` branch too (auto-attach on first sight) | `drops a message for an unknown id, and does not conjure a port for it` |
| 2 | in the `close` branch, drop `handle.markClosed()` | `closes both ends when either closes…` (the far end keeps posting, so `serverMessages` reaches 2) |
| 3 | in `virtual-port.ts`'s `close()`, drop the `if (closed) return;` guard | `closes both ends when either closes…` (two closes on the wire) |
| 4 | in `openPort`, drop the `maxPorts` check | `refuses to open beyond maxPorts…` |
| 5 | change `nextId += 2` to `nextId += 1` | `allocates even ids…` (Task 3) |
| 6 | in `handleEnvelope`'s `message` branch, deliver to *every* open handle rather than `open.get(id)` | `keeps ports isolated…`, `preserves ordering within a port` |

**Row 6 is the isolation test's real killer.** Deleting `open.delete(id)` from `requestClose` — the
obvious-looking mutation — does *not* turn the isolation test red, because that map entry is only
consulted for inbound traffic and the peer has already closed its own end. Do not add a test purely
to make that deletion detectable; note it as uncovered instead. It is bookkeeping hygiene, not a
behaviour anything can observe.

**The inbound `maxPorts` path is not covered by any row**, because the current `maxPorts` test only
exercises the outbound throw. If you want it covered, forge a third inbound OPEN directly onto the
wire — `a.postMessage({ type: "open", id: 99 })` after two ports are already open — and assert
`onPort` is not called a third time. Add it only if you also confirm it turns red when the
`open.size >= maxPorts` check is removed; a test that cannot fail is worse than an absent one.

- [ ] **Step 4: Run the whole package suite and commit**

```bash
pnpm --filter @statewalker/webrun-ports test
pnpm --filter @statewalker/webrun-ports lint
git add packages/webrun-ports
git commit -m "test(ports): the layer 1 invariants, with mutations that kill them

Drop-never-queue, isolation, per-port ordering, bidirectional idempotent close,
maxPorts, and composability — a multiplexer over a virtual port of another
multiplexer.

Each drop test asserts a floor beside its ceiling: a real message gets through
in the same run, so 'the ghost message did not arrive' is evidence rather than
an artefact of nothing having run."
```

Expected: 24 tests in the package.

---

### Task 5: README, root tables, changeset

**Files:**
- Create: `packages/webrun-ports/README.md`
- Create: `.changeset/<generated>.md`
- Modify: `README.md` (root)

**Interfaces:**
- Consumes: the full public surface from Tasks 1–4. Produces nothing consumed by later tasks in this plan.

> **This is a documentation task, not a TDD cycle.** There is no behaviour to drive with a test. Its check is Step 4: the README's code examples must actually run.

- [ ] **Step 1: Write the package README**

Create `packages/webrun-ports/README.md`:

```markdown
# @statewalker/webrun-ports

Turn one message port into many.

A `PortMux` takes a single port and hands out virtual ones. Each virtual port is
itself a `MessageTarget` — the same shape as a `MessagePort` — so whatever runs
on top cannot tell a virtual port from a real one, and a multiplexer can even run
over another multiplexer's port.

## Why it exists

Multiplexing keeps getting rebuilt at the wrong layer. A transport that offers
one pipe needs streams multiplexed over it; a transport that already multiplexes
natively does not. Putting that seam at *ports* rather than at *streams* means
the thing above — streams, calls, RPC — is written once and runs everywhere,
and the emulation exists only where a transport genuinely offers one pipe.

## What it deliberately does not do

A port sends and receives messages. That is all.

No backpressure, no acknowledgements, no credit, no buffering ceiling. This
matches `MessagePort` semantics exactly, and it is what keeps the layer small
enough to reason about. Waiting strategies belong above.

The one safety property it does hold: **a message for a port with no consumer is
dropped, never queued.** Layer 1 never accumulates on behalf of a consumer that
does not exist, so a peer that floods an unaccepted port cannot grow memory here.

## Install

```bash
pnpm add @statewalker/webrun-ports
```

## Getting started

```ts
import { multiplexPort, structuredCodec } from "@statewalker/webrun-ports";

const channel = new MessageChannel();

// The responder accepts inbound ports.
const server = multiplexPort(channel.port2, {
  codec: structuredCodec,
  side: "responder",
  onPort: (port, meta) => {
    if (meta !== "chat") return false; // reject anything else
    port.addEventListener("message", (event) => {
      port.postMessage(`echo: ${String(event.data)}`);
    });
  },
});

// The initiator opens them.
const client = multiplexPort(channel.port1, { codec: structuredCodec });
const chat = client.openPort("chat");
chat.addEventListener("message", (event) => console.log(event.data));
chat.postMessage("hello");
// -> "echo: hello"

await client.close();
await server.close();
```

## API

### `multiplexPort(port, options): PortMux`

The default implementation, which emulates multiplexing over a single port. A
transport that already multiplexes natively supplies its own `PortMux` instead.

| option | type | meaning |
| --- | --- | --- |
| `codec` | `PortCodec` | How envelopes reach the wire. Required. |
| `onPort` | `(port, meta?) => boolean \| undefined` | Called when the peer opens a port. Return `false` to reject. **Without it, inbound ports are rejected.** |
| `side` | `"initiator" \| "responder"` | Id parity — initiator allocates even, responder odd, so both ends may open concurrently. Defaults to `"initiator"`. |
| `maxPorts` | `number` | Ceiling on concurrently open ports. Defaults to `1024`. Bounds the id table only; it never delays a message. |
| `maxMessageSize` | `number` | Largest message this transport can carry, if it has a limit. Reported, not enforced — the layer above chunks to it. |

### `PortMux`

| member | meaning |
| --- | --- |
| `openPort(meta?)` | Allocate a port, announce it, and return the local end immediately. Does not wait for the peer to accept. Throws `RangeError` past `maxPorts`. |
| `close()` | Close every virtual port, then release the underlying port. |
| `maxMessageSize` | See above. |

`openPort` returning before acceptance is deliberate: it keeps layer 1 free of
round trips. Messages posted before the peer accepts are sent, and dropped at the
far end if it rejects — the local port is then closed, so the rejection is
observable rather than silent.

### `structuredCodec`

For ports whose messages are structured values. Envelopes pass through
unencoded, so nothing is serialised and `ArrayBuffer`s move zero-copy through the
transfer list.

A byte transport needs a codec that encodes; that one ships with
`@statewalker/webrun-msgpack`, so this package keeps no dependencies.

### `PortEnvelope`

What crosses the wire: `{ type: "open", id, meta? }`, `{ type: "message", id,
payload }`, `{ type: "close", id, reason? }`. `reason` is opaque — layer 1 never
inspects it.

## Dependencies

**None at runtime.** `@statewalker/webrun-streams` is imported for types only
(`MessageTarget`, `MessageListener`) and is erased at build time.

## Licence

MIT
```

- [ ] **Step 2: Add the root README row**

In `README.md`, in the same table as `@statewalker/webrun-streams` (around line 129), add immediately after the `webrun-streams` row:

```markdown
| [`@statewalker/webrun-ports`](./packages/webrun-ports) | 0.1.0 | Turn one message port into many. Explicit lifecycle, pluggable codec, no flow control. **Zero runtime dependencies.** |
```

- [ ] **Step 3: Add the changeset**

Create `.changeset/port-multiplexer-layer-1.md`:

```markdown
---
"@statewalker/webrun-ports": minor
---

New package: a port multiplexer.

`multiplexPort` turns one `MessageTarget` into many virtual ones, with explicit
`open`/`close` lifecycle and an accept callback. Virtual ports are themselves
`MessageTarget`s, so the multiplexer composes and a real `MessagePort` is
substitutable for a virtual one.

Layer 1 has no flow control by design — no backpressure, acknowledgements,
credit or buffering ceiling — and a message for a port with no consumer is
dropped rather than queued, so an unaccepted port cannot accumulate memory.

`structuredCodec` ships here; the byte codec lives in `@statewalker/webrun-msgpack`
so this package keeps zero runtime dependencies.
```

`minor`, not `patch`: this publishes a new package with a new public API. The
repository sets `updateInternalDependencies: "minor"` deliberately, but nothing
depends on `webrun-ports` yet, so no other package is bumped by this.

- [ ] **Step 4: Verify the README examples actually run**

The getting-started example is the package's front door, and a broken one is
worse than none. Check it mechanically:

```bash
cat > /tmp/webrun-ports-readme-check.mjs <<'EOF'
import { multiplexPort, structuredCodec } from "./packages/webrun-ports/dist/index.js";

const channel = new MessageChannel();
const seen = [];

const server = multiplexPort(channel.port2, {
  codec: structuredCodec,
  side: "responder",
  onPort: (port, meta) => {
    if (meta !== "chat") return false;
    port.addEventListener("message", (event) => {
      port.postMessage(`echo: ${String(event.data)}`);
    });
  },
});

const client = multiplexPort(channel.port1, { codec: structuredCodec });
const chat = client.openPort("chat");
chat.addEventListener("message", (event) => seen.push(event.data));
chat.postMessage("hello");

await new Promise((r) => setTimeout(r, 50));
await client.close();
await server.close();

if (seen[0] !== "echo: hello") {
  console.error("README example produced", seen);
  process.exit(1);
}
console.log("README example OK");
EOF
pnpm --filter @statewalker/webrun-ports build
node /tmp/webrun-ports-readme-check.mjs
rm /tmp/webrun-ports-readme-check.mjs
```

Expected: `README example OK`. If it fails, fix the README, not the check.

- [ ] **Step 5: Full verification**

```bash
pnpm --filter @statewalker/webrun-ports test
pnpm --filter @statewalker/webrun-ports typecheck
pnpm --filter @statewalker/webrun-ports lint
pnpm --filter @statewalker/webrun-ports build
ls packages/webrun-ports/dist/index.js packages/webrun-ports/dist/index.d.ts
grep -c "webrun-streams" packages/webrun-ports/dist/index.js
```

Expected: 24 tests passing; typecheck, lint and build exit 0; both `dist` files
present; the `grep -c` prints `0`, confirming the dependency stayed type-only.

- [ ] **Step 6: Confirm nothing outside this package changed**

```bash
git status --porcelain
pnpm -r test 2>&1 | grep -E "Tests |failed" | tail -20
```

Expected: only `packages/webrun-ports/`, `tsconfig.base.json`, `README.md` and
`.changeset/` appear. The rest of the repository was at **683 passing / 5
skipped** before this plan; it must still be, plus this package's 24 — no
existing suite changes, because this plan modifies no existing code.

- [ ] **Step 7: Commit**

```bash
git add packages/webrun-ports/README.md README.md .changeset/port-multiplexer-layer-1.md
git commit -m "docs(ports): README, root package table row, changeset

The getting-started example is verified against the built bundle rather than
being written and hoped for.

Records what the package deliberately does not do — no backpressure,
acknowledgements, credit or ceiling — because the omission is the design, and a
reader who assumes otherwise will build on a guarantee that is not there."
```

---

## Verification summary

| check | expectation |
| --- | --- |
| `pnpm --filter @statewalker/webrun-ports test` | 24 passing |
| `pnpm --filter @statewalker/webrun-ports typecheck` | exit 0 |
| `pnpm --filter @statewalker/webrun-ports lint` | exit 0 |
| `pnpm --filter @statewalker/webrun-ports build` | exit 0; `dist/index.js` + `dist/index.d.ts` |
| `grep -c webrun-streams packages/webrun-ports/dist/index.js` | `0` — the dependency is type-only |
| `pnpm -r test` | 683 + 24 passing, 5 skipped; no existing suite changed |

Test count by file: `structured-codec.test.ts` 5, `virtual-port.test.ts` 6,
`multiplex-port.test.ts` 6, `invariants.test.ts` 7. Per-task deltas, not a
running total — a cumulative figure in a plan goes stale the moment any task
adds a test, which has already caused three corrections in this repository.

## What Plan B will need from this

- `multiplexPort(port, { codec, onPort, side, maxPorts, maxMessageSize }): PortMux`
- `PortMux.openPort(meta?): MessageTarget`, `PortMux.close(): Promise<void>`, `PortMux.maxMessageSize?: number`
- `structuredCodec: PortCodec`, and `PortCodec` for `webrun-msgpack` to implement
- The `meta` field carries layer 2's port-kind discriminator (`{ kind: "control" }` / `{ kind: "stream" }`); layer 1 passes it through without inspecting it.
