# Plan B1 — packaging and relocation for the port layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the port layer and the RPC tier in one package — `@statewalker/webrun-rpc` — leaving `webrun-streams` as generic stream functionality, with no behavioural change.

**Architecture:** `webrun-streams-port` is renamed to `webrun-rpc`; `MessageTarget` and the port layer move into it from `webrun-streams`; the RPC primitives are retyped from `MessagePort` to `MessageTarget` so they work over any transport; and `openPort` becomes asynchronous so an emulated multiplexer and a natively multiplexed transport share one shape. Nothing else changes: no adapter is touched, no stream semantics are built, and every existing test must still pass.

**Tech Stack:** TypeScript strict, ESM only, `moduleResolution: "Bundler"`, vitest, biome, rolldown, changesets.

**Spec:** `docs/superpowers/specs/2026-09-05-port-multiplexer-design.md` — read it first, in particular D1, D2, D20, D21 and D22.

## Global Constraints

- **`webrun-streams` has zero runtime dependencies** and must still have zero when this lands.
- **`webrun-rpc` depends on `webrun-streams` and nothing else** — for `Duplex`, the iterator utilities and error serialisation. The edge runs one way; `webrun-streams` must never import from `webrun-rpc`.
- **No behavioural change.** This plan moves code and changes types. Any test that passes before a task must pass after it, with the same assertions. If a test has to change to keep passing, that is a behavioural change — stop and report it.
- **No adapter is modified.** `webrun-streams-{ws,livekit,peerjs,webrtc,libp2p}` and `webrun-streams-conformance` are untouched. Adapters move to port factories in Plan C.
- **`duplexOverPort` is not built here.** That is Plan B2.
- **`emulateMux` is not deleted here.** That is Plan C. It stays working and tested throughout.
- ESM only (`"type": "module"`), TypeScript strict, `moduleResolution: "Bundler"`, relative imports carry a `.js` suffix.
- biome: 2-space indent, line width 100, double quotes, semicolons always, trailing commas all. Use the **package-scoped** lint before each commit; the root `pnpm lint` exits 1 on a pre-existing baseline and is not this plan's gate.
- **A filtered command that prints `None of the selected packages has a "<script>" script` EXITS 0.**
  Treat that line as a failure, always. `webrun-rpc` had no `typecheck` script until Task 1 added
  one (`tsc --noEmit`); before that, every `pnpm --filter @statewalker/webrun-rpc
  typecheck` in this plan would have reported success without compiling anything — and Task 4's red
  phase *is* a typecheck, so it would have produced a green red phase. If any command in this plan
  prints that line, stop and report it rather than treating the exit code as the answer.
- Tests: vitest, files under `tests/`, named `*.test.ts`.
- **`virtual-port.js` is never exported from any barrel.** `VirtualPortHandle` carries `deliver` and `markClosed`, which are the multiplexer's private levers; publishing them would let a consumer forge inbound traffic.
- **Per-task test deltas, never running totals.** Counts in this plan are per-task deltas because absolute totals go stale the moment a fix round adds a test — that mistake cost four corrections across the two previous plans.

## Starting state

- `webrun-streams`: 24 test files, **201 tests**. Contains the port layer (`message-target`, `port-types`, `multiplex-port`, `structured-codec`, `virtual-port`) plus generic stream code and `emulateMux`.
- `webrun-streams-port`: 6 test files. Contains the RPC tier (`call-port`, `call-bidi`, `listen-port`, `listen-bidi`, `io-send`, `io-handle`, `send`, `recieve`, `cancel-channel`, `close-signal`) **and** a MessagePort transport adapter (`byte-channel`, `connect-serve`).
- Repo-wide: **717 passing / 5 skipped**.
- `origin/main` is at `d8675e6`.

## Facts established before this plan was written

- **No workspace package declares `@statewalker/webrun-streams-port` as a dependency.** The only references outside the package are two *comments* in `webrun-http-streams` — one of which says "`webrun-streams-port` is not a dependency of this package". The rename's real blast radius is its own tests plus documentation.
- **`MessageTarget` is imported by exactly two places**: `webrun-http-browser` (through a one-line re-export shim at `src/core/message-target.ts`) and `webrun-streams`' own port layer. `emulateMux` does not use it at all (0 occurrences).
- **`MessagePort` appears in 13 files** of the RPC tier, `openPort` at 32 call sites across `webrun-streams`' source and tests.
- **`@statewalker/webrun-streams-port` is published at 0.1.1 and `private: false`**, so the npm rename is a breaking change even though nothing in the workspace depends on it.

## File Structure

**Rename**
- `packages/webrun-streams-port/` → `packages/webrun-rpc/`, package name `@statewalker/webrun-streams-port` → `@statewalker/webrun-rpc`.

**Move, `webrun-streams` → `webrun-rpc`**
- `src/message-target.ts`, `src/port-types.ts`, `src/multiplex-port.ts`, `src/structured-codec.ts`, `src/virtual-port.ts`
- `tests/message-target.test.ts`, `tests/multiplex-port.test.ts`, `tests/structured-codec.test.ts`, `tests/virtual-port.test.ts`, `tests/port-mux-invariants.test.ts`, `tests/port-mux-lifecycle.test.ts`

**Modify**
- `packages/webrun-rpc/src/*.ts` — RPC tier retyped from `MessagePort` to `MessageTarget`.
- `packages/webrun-rpc/src/multiplex-port.ts` — `openPort` becomes async.
- `packages/webrun-streams/src/index.ts` — loses the port-layer exports.
- `packages/webrun-http-browser/src/core/message-target.ts` — the shim repoints to `webrun-rpc`.
- `packages/webrun-http-browser/package.json` — gains `@statewalker/webrun-rpc`.
- `tsconfig.base.json`, root `README.md`, both package READMEs, `.changeset/`.

**Deliberately unchanged**
- `packages/webrun-streams/src/{duplex,emulate-mux,errors,flow-control,uint32,collect,lines,map,normalize,text,to-chunks,readable-streams,send-iterator,recieve-iterator,new-async-generator,jsonl}.ts`
- Every `webrun-streams-*` adapter and `webrun-streams-conformance`.

---

### Task 1: Rename the package

**Files:**
- Rename: `packages/webrun-streams-port/` → `packages/webrun-rpc/`
- Modify: `packages/webrun-rpc/package.json`, `tsconfig.base.json`, `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the package `@statewalker/webrun-rpc` at the path `packages/webrun-rpc`, exporting exactly what `webrun-streams-port` exported. Later tasks add to it.

- [ ] **Step 1: Move the directory with history**

```bash
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/workspaces/webrun-wire
git mv packages/webrun-streams-port packages/webrun-rpc
```

`git mv` keeps the rename detectable in history, which a delete-and-recreate would not.

- [ ] **Step 2: Rename the package itself**

In `packages/webrun-rpc/package.json`, change three fields:

```json
  "name": "@statewalker/webrun-rpc",
```

```json
  "repository": {
    "type": "git",
    "url": "git@github.com:statewalker/webrun-wire.git",
    "directory": "packages/webrun-rpc"
  },
```

and the description, which currently describes a transport adapter:

```json
  "description": "Ports and RPC over them: a port multiplexer, and typed request/response and streaming primitives over any MessageTarget.",
```

- [ ] **Step 3: Repoint the path alias**

In `tsconfig.base.json`, replace the `webrun-streams-port` entry, keeping the map alphabetical — `@statewalker/webrun-rpc` sorts before `@statewalker/webrun-streams`:

```json
    "@statewalker/webrun-rpc": ["./packages/webrun-rpc/src"],
```

- [ ] **Step 4: Reinstall so the workspace picks up the new name**

```bash
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev && pnpm install
```

Run this from the **assembly root**, not the umbrella root one level up: the umbrella's `pnpm-workspace.yaml` globs a `workspaces/` directory that does not exist there, so an install from it is a silent no-op. The assembly lockfile is gitignored.

- [ ] **Step 5: Verify the package still builds and tests**

```bash
pnpm --filter @statewalker/webrun-rpc test
pnpm --filter @statewalker/webrun-rpc typecheck
pnpm --filter @statewalker/webrun-rpc lint
```

Expected: all three exit 0, 6 test files. Record the test count you measure — it becomes the baseline for Task 3.

- [ ] **Step 6: Update the root README**

Two places mention the old name. In the architecture diagram around line 100:

```
    │     webrun-rpc                 (ports + RPC: MessagePort, workers, iframes)
```

and the package table row around line 269 — replace it with:

```markdown
| [`@statewalker/webrun-rpc`](./packages/webrun-rpc) | 0.1.1 | Ports and RPC over them: `multiplexPort`, and typed request/response and streaming primitives (`callPort` / `listenPort` / `callBidi` / `ioSend`) over any `MessageTarget`. | — |
```

- [ ] **Step 7: Commit**

```bash
git add -A packages/webrun-rpc packages/webrun-streams-port tsconfig.base.json README.md
git commit -m "refactor(rpc)!: rename webrun-streams-port to webrun-rpc

Its transport role is going away — a MessagePort satisfies MessageTarget
structurally, so there is nothing to adapt — leaving the transport-agnostic RPC
tier it was already carrying. The package is renamed rather than deleted so that
tier keeps its history and its tests.

No workspace package declares it as a dependency, and the only external
references are two comments, so the rename's blast radius is its own tests plus
documentation. The npm name change still needs a major changeset (Task 5)."
```

---

### Task 2: Move `MessageTarget` and the port layer into `webrun-rpc`

**Files:**
- Move: `packages/webrun-streams/src/{message-target,port-types,multiplex-port,structured-codec,virtual-port}.ts` → `packages/webrun-rpc/src/`
- Move: `packages/webrun-streams/tests/{message-target,multiplex-port,structured-codec,virtual-port,port-mux-invariants,port-mux-lifecycle}.test.ts` → `packages/webrun-rpc/tests/`
- Modify: `packages/webrun-streams/src/index.ts`, `packages/webrun-rpc/src/index.ts`
- Modify: `packages/webrun-http-browser/src/core/message-target.ts`, `packages/webrun-http-browser/package.json`

**Interfaces:**
- Consumes: the renamed package from Task 1.
- Produces: `@statewalker/webrun-rpc` exports `MessageTarget`, `MessageListener`, `MessageSource`, `MessageSink`, `PortCodec`, `PortEnvelope`, `PortMux`, `PortMuxOptions`, `multiplexPort`, `DEFAULT_MAX_PORTS`, `structuredCodec` — plus everything it already exported. `webrun-streams` no longer exports any of them.

- [ ] **Step 1: Move the source files**

```bash
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/workspaces/webrun-wire
for f in message-target port-types multiplex-port structured-codec virtual-port; do
  git mv packages/webrun-streams/src/$f.ts packages/webrun-rpc/src/$f.ts
done
for f in message-target multiplex-port structured-codec virtual-port port-mux-invariants port-mux-lifecycle; do
  git mv packages/webrun-streams/tests/$f.test.ts packages/webrun-rpc/tests/$f.test.ts
done
```

- [ ] **Step 2: Drop the port exports from `webrun-streams`' barrel**

In `packages/webrun-streams/src/index.ts`, delete these four lines:

```ts
export * from "./message-target.js";
export { DEFAULT_MAX_PORTS, multiplexPort } from "./multiplex-port.js";
export type { PortCodec, PortEnvelope, PortMux, PortMuxOptions } from "./port-types.js";
export { structuredCodec } from "./structured-codec.js";
```

- [ ] **Step 3: Add them to `webrun-rpc`'s barrel**

In `packages/webrun-rpc/src/index.ts`, add these four lines, keeping the file's existing alphabetical ordering:

```ts
export * from "./message-target.js";
export { DEFAULT_MAX_PORTS, multiplexPort } from "./multiplex-port.js";
export type { PortCodec, PortEnvelope, PortMux, PortMuxOptions } from "./port-types.js";
export { structuredCodec } from "./structured-codec.js";
```

Do **not** add `virtual-port.js`. `VirtualPortHandle` exposes `deliver` and `markClosed`, the multiplexer's private levers.

- [ ] **Step 4: Repoint `webrun-http-browser`'s shim**

`packages/webrun-http-browser/src/core/message-target.ts` currently re-exports from `@statewalker/webrun-streams`. Replace its whole body with:

```ts
// Re-exported from @statewalker/webrun-rpc, which owns the port layer, so this
// package's five internal importers and its public API are unchanged.
export type {
  MessageListener,
  MessageSink,
  MessageSource,
  MessageTarget,
} from "@statewalker/webrun-rpc";
```

and add the dependency to `packages/webrun-http-browser/package.json`, keeping `dependencies` alphabetical:

```json
    "@statewalker/webrun-rpc": "workspace:*",
```

- [ ] **Step 5: Reinstall and typecheck the whole repo**

```bash
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev && pnpm install
cd /home/kotelnikov/workspace-statewalker/umbrella-next/worktrees/dev/workspaces/webrun-wire && pnpm -r typecheck
```

Expected: exit 0 everywhere. A failure here names a file that imported a port type from `webrun-streams` — fix that import to `@statewalker/webrun-rpc` rather than re-adding the export.

- [ ] **Step 6: Run both suites and the whole repo**

```bash
pnpm --filter @statewalker/webrun-streams test
pnpm --filter @statewalker/webrun-rpc test
pnpm -r test
```

Expected: `webrun-streams` **loses 36 tests** (5 codec + 8 virtual-port + 6 multiplex-port + 7 invariants + 8 lifecycle + 2 message-target), and `webrun-rpc` gains exactly those 36. Measured during execution: `webrun-streams` 201 -> 165, `webrun-rpc` 35 -> 71. An earlier draft of this line guessed 40 by assuming `message-target.test.ts` held 6 tests; it holds 2. The repo-wide total is unchanged, because nothing was added or removed — only moved. **If the repo-wide total changes, stop**: a test was lost in the move.

- [ ] **Step 7: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-streams lint
pnpm --filter @statewalker/webrun-rpc lint
pnpm --filter @statewalker/webrun-http-browser lint
git add -A packages tsconfig.base.json
git commit -m "refactor!: move MessageTarget and the port layer into webrun-rpc

webrun-streams becomes generic stream functionality — Duplex, Connect, Serve,
the iterator utilities, error serialisation — and stops knowing what a port is.
emulateMux never used MessageTarget, so nothing it does is affected.

Duplex deliberately stays behind: webrun-http-streams consumes it and touches
nothing port-related, so moving it would make an HTTP-over-streams package
depend on an RPC package to describe a byte stream.

Breaking for both packages: webrun-streams loses four public exports and
webrun-rpc gains them. No test changes — 40 tests move intact and the repo-wide
total is unchanged."
```

---

### Task 3: Retype the RPC tier from `MessagePort` to `MessageTarget`

**Files:**
- Modify: `packages/webrun-rpc/src/{call-port,call-bidi,listen-port,listen-bidi,io-send,io-handle,send,recieve,cancel-channel,close-signal}.ts`
- Test: the package's existing 6 test files must pass unchanged.

**Interfaces:**
- Consumes: `MessageTarget` from `./message-target.js` (moved in Task 2).
- Produces: every RPC primitive accepts a `MessageTarget` rather than a `MessagePort`. Plan B2's `duplexOverPort` depends on this — it runs `callPort` over a **virtual** port, which is a `MessageTarget` and not a `MessagePort`.

This is the task that makes the RPC tier transport-agnostic. It currently works on one transport only because of these type annotations, not because of anything it does.

- [ ] **Step 1: Establish the baseline**

```bash
pnpm --filter @statewalker/webrun-rpc test
```

Record the exact count. Every one of these tests must still pass at Step 4 **without modification** — they drive real `MessagePort`s, and a `MessagePort` satisfies `MessageTarget`, so nothing about their behaviour changes.

- [ ] **Step 2: Retype, file by file**

`MessagePort` appears in these files, with this many occurrences each: `call-port.ts` 2, `call-bidi.ts` 1, `listen-port.ts` 1, `listen-bidi.ts` 1, `io-send.ts` 2, `io-handle.ts` 2, `send.ts` 1, `recieve.ts` 1, `cancel-channel.ts` 2, `close-signal.ts` 4.

In each, replace the **parameter and field types** `MessagePort` with `MessageTarget`, importing it type-only:

```ts
import type { MessageTarget } from "./message-target.js";
```

Two files need care rather than a blind substitution:

- **`close-signal.ts`** keys a `WeakMap` on the port. `MessageTarget` is an interface, and a `WeakMap` key must be an object — which every `MessageTarget` implementation is, so `WeakMap<MessageTarget, AbortSignal>` is valid. Change the key type with the rest.
- **`byte-channel.ts` and `connect-serve.ts` are NOT in this list.** They are the MessagePort transport adapter, they genuinely need a real `MessagePort` (they call `postMessage` with transferables and rely on `start()`), and Plan C deletes them. Leave them alone.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @statewalker/webrun-rpc typecheck
```

Expected: exit 0. If a `MessagePort`-only member is being used somewhere — `start()`, `close()` — the compiler names it. `MessageTarget` declares both as optional, so the fix is `port.start?.()` rather than widening the type back.

- [ ] **Step 4: Run the suite unchanged**

```bash
pnpm --filter @statewalker/webrun-rpc test
```

Expected: the same count as Step 1, all passing, **with no test file modified**. Confirm with:

```bash
git status --porcelain packages/webrun-rpc/tests/
```

Expected: empty. If a test had to change, the retyping altered behaviour — stop and report which test and why.

- [ ] **Step 5: Prove the retyping actually widened the surface**

A passing suite does not show that anything was gained: these tests all pass a real `MessagePort`, which satisfied the old signature too. Add one test that could not have compiled before, in a new file `packages/webrun-rpc/tests/message-target-callers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { callPort } from "../src/call-port.js";
import { listenPort } from "../src/listen-port.js";
import type { MessageListener, MessageTarget } from "../src/message-target.js";

/**
 * A MessageTarget that is emphatically not a MessagePort: two plain objects
 * wired to each other. Before this task the RPC tier could not accept one.
 */
function newTargetPair(): { a: MessageTarget; b: MessageTarget } {
  const listeners = { a: new Set<MessageListener>(), b: new Set<MessageListener>() };
  const make = (self: "a" | "b", peer: "a" | "b"): MessageTarget => ({
    addEventListener(_type, listener) {
      listeners[self].add(listener);
    },
    removeEventListener(_type, listener) {
      listeners[self].delete(listener);
    },
    postMessage(message) {
      // Deliver on a later task, matching MessagePort's asynchrony.
      setTimeout(() => {
        for (const listener of [...listeners[peer]]) {
          void listener(new MessageEvent("message", { data: message }));
        }
      }, 0);
    },
  });
  return { a: make("a", "b"), b: make("b", "a") };
}

describe("the RPC tier over a plain MessageTarget", () => {
  it("completes a request/response round trip with no MessagePort involved", async () => {
    const { a, b } = newTargetPair();
    const off = listenPort(b, async (params) => ({ echoed: params }));
    try {
      const result = await callPort(a, { hello: "world" }, { timeout: 2000 });
      expect(result).toEqual({ echoed: { hello: "world" } });
    } finally {
      off();
    }
  });
});
```

- [ ] **Step 6: Run it, then prove it is the retyping that made it possible**

```bash
pnpm --filter @statewalker/webrun-rpc exec vitest run tests/message-target-callers.test.ts
```

Expected: 1 test passing.

Then revert one annotation to show the test could not have existed before: change `call-port.ts`'s port parameter back to `MessagePort` and run `pnpm --filter @statewalker/webrun-rpc typecheck`. Expected: a type error naming `message-target-callers.test.ts`. Restore it with `git checkout -- packages/webrun-rpc/src/call-port.ts` — an exact path, **never** a directory.

Record the measured error text in your report. This is the step that distinguishes "the tests still pass" from "the change did something".

- [ ] **Step 7: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-rpc lint
git add packages/webrun-rpc/src packages/webrun-rpc/tests/message-target-callers.test.ts
git commit -m "refactor(rpc)!: the RPC tier takes a MessageTarget, not a MessagePort

These primitives were always transport-agnostic; they worked on one transport
because of a type annotation. Retyping them is what lets Plan B2 run callPort
over a virtual port, which is a MessageTarget and never a MessagePort.

The existing suite passes unmodified because a MessagePort satisfies
MessageTarget. That proves nothing broke, not that anything was gained, so a
test drives the tier over two plain objects wired to each other — it does not
compile against the old signature.

byte-channel.ts and connect-serve.ts keep their real MessagePort: they use
transferables and start(), and Plan C deletes them."
```

---

### Task 4: Make `openPort` asynchronous

**Files:**
- Modify: `packages/webrun-rpc/src/port-types.ts`, `packages/webrun-rpc/src/multiplex-port.ts`
- Modify: `packages/webrun-rpc/tests/{multiplex-port,port-mux-invariants,port-mux-lifecycle}.test.ts`

**Interfaces:**
- Consumes: the port layer as moved in Task 2.
- Produces: `PortMux.openPort(meta?: unknown): Promise<MessageTarget>`. Every caller awaits. Plan C's native adapters implement this shape directly.

Spec D2: a native factory cannot be synchronous — `createDataChannel` needs a wait-for-open and `dialProtocol` is async — and an emulated mux is only interchangeable with one if they share a shape. The emulated implementation returns an already-resolved promise, so send-before-accept (D5) still costs no round trip.

- [ ] **Step 1: Change the type**

In `packages/webrun-rpc/src/port-types.ts`, in the `PortMux` interface:

```ts
  /** Allocate a port, announce it, and return the local end. */
  openPort(meta?: unknown): Promise<MessageTarget>;
```

- [ ] **Step 2: Run the typecheck to enumerate the call sites**

```bash
pnpm --filter @statewalker/webrun-rpc typecheck
```

Expected: **failures**, one per call site that uses the returned port without awaiting. This is the red phase — the compiler is the test here, and the error list is your work list. Record it.

- [ ] **Step 3: Make the implementation async**

In `packages/webrun-rpc/src/multiplex-port.ts`, change the method signature only:

```ts
    async openPort(meta?: unknown): Promise<MessageTarget> {
```

The body is unchanged. `openPort` still allocates, posts `open`, and returns the local end without waiting for the peer — `async` here adds a resolved promise, not a round trip.

- [ ] **Step 4: Await at every call site**

Add `await` to each site the compiler named, in the three test files. They are inside `async` test bodies already, so this is a one-word change per site — for example:

```ts
const port = await client.openPort();
```

Do **not** restructure a test while adding `await`. If a site cannot simply be awaited, say so in your report rather than rewriting the test.

- [ ] **Step 5: Typecheck and run**

```bash
pnpm --filter @statewalker/webrun-rpc typecheck
pnpm --filter @statewalker/webrun-rpc test
```

Expected: typecheck exit 0, and the same test count as Task 3 Step 4 plus the one test Task 3 added — all passing, with no assertions changed.

- [ ] **Step 6: Confirm no round trip was added**

`openPort` must still return before the peer accepts (D5). The existing test `rejects an inbound port when onPort returns false, and closes the opener's end` posts on the port immediately after opening it and asserts the message is sent — if `openPort` had started awaiting the peer, that post would happen after the rejection and the test would fail. Confirm it still passes and name it in your report.

- [ ] **Step 7: Run the suite 15 times**

```bash
for i in $(seq 1 15); do pnpm --filter @statewalker/webrun-rpc test 2>&1 | grep -E "Tests "; done
```

Expected: 15 identical lines, 0 failures. Adding an await changes task ordering, and this package's tests have flaked once before on exactly that kind of change — an 8% failure rate that only appeared under concurrent-file load.

- [ ] **Step 8: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-rpc lint
git add packages/webrun-rpc
git commit -m "feat(rpc)!: openPort is asynchronous

A natively multiplexed transport cannot produce a port synchronously —
createDataChannel needs a wait-for-open and dialProtocol is async — and an
emulated multiplexer is only interchangeable with one if they share a shape.
Plan C's adapters implement this signature directly.

The emulated implementation returns an already-resolved promise, so
send-before-accept still costs no round trip; the rejection test that posts
immediately after opening still passes."
```

---

### Task 5: Documentation and changesets

**Files:**
- Modify: `packages/webrun-rpc/README.md`, `packages/webrun-streams/README.md`, root `README.md`
- Create: `.changeset/<generated>.md`
- Modify: `docs/superpowers/2026-09-05-port-mux-layer-1-findings.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4. Produces nothing consumed downstream.

> **Documentation task, not a TDD cycle.** Its check is Step 5: the READMEs' examples must run against the built bundles.

- [ ] **Step 1: Move the port documentation into `webrun-rpc`'s README**

**This is a move, not a rewrite.** `packages/webrun-streams/README.md` already documents the port
layer accurately under `### Port multiplexing` (restored in commit `1e868cd`): the `multiplexPort`
option table, `PortMux`, `structuredCodec`, `PortEnvelope`, the drop-never-queue property and the
close-observability limitation. Cut that whole section — from the `### Port multiplexing` heading to
the line before `### Credit` — and paste it into `packages/webrun-rpc/README.md`, promoting its
headings one level (`####` → `###`) since it becomes a top-level section there.

Then make exactly two corrections to the moved text, because Task 4 changed the API:

```markdown
| `openPort(meta?)` | Allocate a port, announce it, and return the local end. **Asynchronous** — a natively multiplexed transport cannot produce a port synchronously, and the two must share a shape. Does not wait for the peer to accept. Throws `RangeError` past `maxPorts`. |
```

and in the paragraph below that table, replace "returning before acceptance" with "returning a
promise that resolves before acceptance".

Also rewrite `webrun-rpc`'s header and opening paragraphs — the file is still the
`webrun-streams-port` adapter README — to describe the package's two halves: the port layer, and the
RPC tier (`callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`, `send`,
`recieve`) which now works over any `MessageTarget`. State the dependency: `@statewalker/webrun-streams`
only.

- [ ] **Step 2: Update `webrun-streams`' README**

Step 1 already removed the `### Port multiplexing` section. Now remove the remaining mentions —
`MessageTarget` appears in the `### Message passing` export table, which also moves to `webrun-rpc`
— and add one line saying the port layer lives in `@statewalker/webrun-rpc`. Verify with:

```bash
grep -nE 'MessageTarget|multiplexPort|PortMux|PortCodec|structuredCodec' packages/webrun-streams/README.md
```

Expected: only the line pointing at `webrun-rpc`.

- [ ] **Step 3: Update the root README**

The `webrun-streams` table row currently claims the `PortMux` port multiplexer. Replace that row with:

```markdown
| [`@statewalker/webrun-streams`](./packages/webrun-streams) | 0.1.1 | The `Duplex` / `ByteChannel` / `Connect` / `Serve` seam, `emulateMux`, and async-iterator primitives. **Zero dependencies.** |
```

- [ ] **Step 4: Write the changeset**

Create `.changeset/port-layer-to-webrun-rpc.md`:

```markdown
---
"@statewalker/webrun-rpc": major
"@statewalker/webrun-streams": major
"@statewalker/webrun-http-browser": patch
---

The port layer moves to `@statewalker/webrun-rpc`, renamed from
`@statewalker/webrun-streams-port`.

`webrun-rpc` is major twice over: the npm package name changed, and `openPort`
is now asynchronous. It gains `MessageTarget`, `PortMux`, `multiplexPort`,
`structuredCodec` and the port envelope types, and its RPC primitives —
`callPort`, `listenPort`, `callBidi`, `listenBidi`, `ioSend`, `ioHandle`,
`send`, `recieve` — now accept any `MessageTarget` rather than only a
`MessagePort`.

`webrun-streams` is major because it loses those exports. It keeps generic
stream functionality: `Duplex`, `Connect`, `Serve`, error serialisation and the
async-iterator utilities. `Duplex` deliberately stays — `webrun-http-streams`
consumes it and touches nothing port-related.

`webrun-http-browser` only repoints a one-line re-export, so it is a patch.
```

`major` for `webrun-streams` is not optional: removing a public export is
breaking, and `.changeset/config.json` sets `updateInternalDependencies: "minor"`,
so the eleven packages depending on it are bumped regardless of the level chosen
here.

- [ ] **Step 5: Verify both READMEs' examples run**

Extract the first fenced `ts` block after `## Getting started` from each README **as committed**, swap only the bare import specifier for the built bundle's absolute path, and run it with `node --experimental-strip-types`. Do not hand-edit the types out, and do not use a copy from this plan.

```bash
pnpm --filter @statewalker/webrun-rpc build
pnpm --filter @statewalker/webrun-streams build
```

This matters more than it looks: Plan A's equivalent check ran a *padded copy* of its example containing a sleep the README did not have, and reported success for a program that was not the published one. Extract from the committed file.

Expected: each prints the output its README claims, exit 0. If one fails, fix the README, not the check.

- [ ] **Step 6: Update the findings document**

`docs/superpowers/2026-09-05-port-mux-layer-1-findings.md` describes the port layer as living in `webrun-streams`. Add a short note at the top recording that Plan B1 moved it to `webrun-rpc`, and update the "For whoever writes Plan B" list to say `openPort` is now async.

- [ ] **Step 7: Full verification**

```bash
pnpm -r test
pnpm -r typecheck
pnpm --filter @statewalker/webrun-rpc lint
pnpm --filter @statewalker/webrun-streams lint
git status --porcelain
```

Expected: repo-wide test total **unchanged from the starting state plus the one test Task 3 added**; typecheck exit 0; both lints exit 0; only intended files modified.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: the port layer now lives in webrun-rpc

READMEs, the root package table, the findings document and a changeset. Both
package majors are real: webrun-rpc changed npm name and made openPort async,
webrun-streams lost four public exports.

Each README's getting-started example was extracted from the committed file and
run against the built bundle — not from a copy, which is how Plan A shipped an
example that did not work while its check reported success."
```

---

## Verification summary

| check | expectation |
| --- | --- |
| `pnpm -r test` | starting total + 1 (Task 3's new test); no other change |
| `pnpm -r typecheck` | exit 0 |
| `pnpm --filter @statewalker/webrun-rpc lint` | exit 0 |
| `pnpm --filter @statewalker/webrun-streams lint` | exit 0 |
| `grep -rn "webrun-streams-port" packages/` | only comments in `webrun-http-streams`, which this plan does not touch |
| `webrun-streams` exports `MessageTarget` | **no** — moved |
| `webrun-rpc` exports `virtual-port` | **no** — never |
| 15-run loop on `webrun-rpc` | 0 failures |

Per-task deltas: Task 2 moves 36 tests between packages (net zero). Task 3 adds 1. Tasks 1, 4 and 5 add none.

## What Plan B2 will need from this

- `@statewalker/webrun-rpc` exporting `MessageTarget`, `PortMux`, `multiplexPort`, `structuredCodec`, and the RPC tier typed against `MessageTarget`.
- `openPort(meta?): Promise<MessageTarget>`.
- `callPort` usable over a virtual port — the mechanism `duplexOverPort` is built on.
- The knowledge that **no close is observable at layer 1**, so layer 2 must send its own end-of-stream message before closing a port, and a stream on a rejected port has only its timeout to fail on.
