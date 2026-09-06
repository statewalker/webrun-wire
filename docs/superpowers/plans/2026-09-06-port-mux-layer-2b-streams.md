# Plan B2 — `duplexOverPort`, `transferPortMux`, and the new stack at the `Duplex` seam

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@statewalker/webrun-rpc` a byte-stream tier that runs one `Duplex` over one port
with window-of-one backpressure, a second `PortMux` that hands the peer real transferred
`MessagePort`s, and a conformance run proving the whole stack is a drop-in at the `Duplex` seam.

**Architecture:** A stream port carries exactly one `Duplex`. Each direction is a sequence of
`callPort` round trips on its own `channelName` — the request is the chunk, the reply is the
confirmation, and the reply is withheld until the local consumer has pulled past the value, so the
producer can never run more than one chunk ahead. Layer 1's `close` is not observable to layer 2
(Plan A finding 2), so cancellation travels as an explicit out-of-band message on the same port.
`transferPortMux` implements the same `PortMux` interface as `multiplexPort` but gets its ports
from the platform: a real `MessageChannel` per `openPort`, one end transferred to the peer.

**Tech Stack:** TypeScript (ES2022, `strict`, DOM lib), vitest 4, biome, pnpm workspaces, turborepo,
changesets. Node ≥ 22 (`MessageChannel`/`MessagePort` are globals).

**Spec:** `docs/superpowers/specs/2026-09-05-port-multiplexer-design.md` — read it. This plan
argues from it; where they disagree, the spec wins and the disagreement is a plan defect to report.

**Prior findings you are expected to have read** (they are short, and each one records a mistake
this plan is shaped to avoid):
- `docs/superpowers/2026-09-05-port-mux-layer-1-findings.md`
- `docs/superpowers/2026-09-05-port-mux-layer-2a-findings.md`

---

## Before you begin — repository state

This plan runs in `worktrees/dev/workspaces/webrun-wire`. Three preconditions, set by the human
partner, must hold before Task 1:

1. **`origin/main` is synchronised.** At the time of writing, local `dev` is **19 commits ahead of
   `origin/main`** and nothing is pushed. Those commits are Plan B1 plus the spec amendments this
   plan argues from. They must be on `origin/main` before implementation starts, so the branch this
   plan creates forks from a published base.
2. **Open PRs are resolved.** PR
   [#4](https://github.com/statewalker/webrun-wire/pull/4) ("webrun-ports: layer 1 of the port
   multiplexer") is open against the synthetic base `review-base/port-mux-layer-1`. Its head
   `d4eb236` **is already an ancestor of `origin/main`** — verified with
   `git merge-base --is-ancestor d4eb236 origin/main` — so it contributes no code and should be
   closed rather than merged. Two other local branches carry unmerged commits and are **out of this
   plan's scope**; note them, do not touch them: `fixes/ecosystem-bugs` (1 commit,
   `9a42aa0 fix(turbo): drop invalid root-level 'extends' key`) and
   `backup/conformance-wire-84ec12f` (7 commits, `webrun-http-streams` and `-libp2p` fixes).
3. **Work happens on a dedicated branch in a dedicated worktree**, created with
   `superpowers:using-git-worktrees` — not on `dev`, and not in the assembly checkout. Suggested
   branch name: `feat/port-mux-layer-2b`.

Do not start Task 1 until all three hold. If any does not, stop and say which.

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **G1. Layer 1 holds nothing (spec D3).** Nothing in this plan may add buffering, credit, or a
  confirmation to `multiplexPort`, `virtual-port.ts`, `structured-codec.ts` or `port-types.ts`.
  Backpressure lives in the files this plan creates.
- **G2. Window of one (spec D11).** "Within one stream, the next chunk is never sent until the
  previous one is delivered *and* confirmed." No pipelining, no configurable window.
- **G3. The confirmation is `callPort` on that stream's own port (spec D12).** No new
  request/response protocol is invented; no `callId` demultiplexing is added.
- **G4. Receiver enforcement is a count of one (spec D15).** "A second unconfirmed chunk is a
  protocol violation, not a resource question, so no byte ceiling and no tunable threshold is
  needed. The penalty is scoped to the offending virtual port." There is **no** `maxBufferedBytes`
  option — an earlier spec draft proposed one and D15 supersedes it.
- **G5. The stream timeout defaults to no timeout at all (spec D8).** "A chunk acknowledgement has
  no deadline of its own: a slow consumer is throttled, never failed."
- **G6. Layer 2's payload contract is the msgpack-expressible subset (spec D16).** Nothing this
  plan sends over a *stream* port may depend on transferables or on carrying a live port inside a
  payload. `transferPortMux` is exempt: it is a layer 1 multiplexer implementation, not a layer 2
  payload (spec D23).
- **G7. Nothing is deleted.** `emulateMux`, `byteChannelFromMessagePort`, `connect`, `serve`,
  `uint32.ts` and the existing conformance run all stay. Deletion is Plan C's job.
- **G8. No changes to `webrun-streams-conformance`.** L6's redefinition and the `PairTuning`
  reshape (spec D17) are sequenced into Plan C, because five adapters still run L6 against
  `emulateMux` where the credit window is real.
- **G9. `pnpm --filter <pkg> <script>` exits 0 when the script does not exist.** It prints
  `None of the selected packages has a "<script>" script` and **succeeds**. Every verification step
  that runs a filtered script must confirm the script ran, not merely that the command exited 0.
  `webrun-rpc` has `test`, `typecheck`, `typecheck:tests`, `lint` and `build`.
- **G10. Never restore a file with `git checkout -- <path>`.** It restores the last *committed*
  state and destroys uncommitted work; this happened three times in this project, once with an
  exact file path. To mutate a file for a probe: `cp` it to `/tmp/…`, mutate, then `cp` back and
  verify with `diff`.
- **G11. Report the real test count; never reconcile to a number this plan states.** Counts here
  are per-task deltas, and even those go stale. `webrun-rpc` was at **75 tests / 13 files** when
  this plan was written; if your baseline differs, say so and continue.
- **G12. Every absence assertion needs a floor.** "No more than N", "nothing follows", "no error"
  are all satisfied by breaking the machinery outright. Each such assertion must sit beside a
  positive assertion that the feature still works.
- **G13. No fixed tick counts in tests.** Waiting a fixed number of macrotasks for `MessagePort`
  delivery produced a measured 8% flake that was invisible when the file ran alone. Poll a
  condition with a labelled timeout.

---

## File structure

| file | responsibility |
| --- | --- |
| `packages/webrun-rpc/src/through-abort.ts` | **Create.** `throughAbort`, moved verbatim out of `send.ts` so both senders share one copy rather than two. |
| `packages/webrun-rpc/src/send.ts` | **Modify.** Import `throughAbort` instead of defining it. |
| `packages/webrun-rpc/src/call-port.ts` | **Modify.** A non-finite or non-positive `timeout` installs no deadline; export `NO_TIMEOUT`. |
| `packages/webrun-rpc/src/duplex-over-port.ts` | **Create.** The whole stream tier: `duplexOverPort`, `serveDuplexOverPort`, the wire chunk shape, the abort notice, the window-of-one receiver, the stream timeout. |
| `packages/webrun-rpc/src/transfer-port-mux.ts` | **Create.** `transferPortMux` — a `PortMux` whose ports are real transferred `MessagePort`s. |
| `packages/webrun-rpc/src/index.ts` | **Modify.** Export the two new modules. |
| `packages/webrun-rpc/tests/duplex-over-port.test.ts` | **Create.** Data path, chunking, half-close, error propagation. |
| `packages/webrun-rpc/tests/duplex-over-port-cancel.test.ts` | **Create.** Cancellation, teardown, the explicit abort notice. |
| `packages/webrun-rpc/tests/duplex-over-port-timeout.test.ts` | **Create.** The F5 regression and the per-stream timeout. |
| `packages/webrun-rpc/tests/duplex-over-port-hostile.test.ts` | **Create.** The layer-2 half of the hostile suite's questions (spec D15). |
| `packages/webrun-rpc/tests/transfer-port-mux.test.ts` | **Create.** Transfer, rejection, teardown, composability. |
| `packages/webrun-rpc/tests/conformance-new-stack.test.ts` | **Create.** A second `describeDuplexAdapter` run over `multiplexPort` + `duplexOverPort`. |
| `packages/webrun-rpc/README.md` | **Modify.** Document the stream tier and `transferPortMux`. |
| `.changeset/duplex-over-port.md` | **Create.** A `minor` for `@statewalker/webrun-rpc`. |

`duplex-over-port.ts` is the one large file. It stays one file because every part of it is the same
protocol seen from two ends: splitting the sender from the receiver would put the two halves of one
invariant (G2/G4) in two files that must be read together to check it.

---

## The protocol, in one place

Read this before Task 2. Every later task refers back to it.

One **stream port** carries exactly one `Duplex` invocation, in both directions:

| direction | mechanism | `channelName` |
| --- | --- | --- |
| caller's `input` → handler | `callPort` per chunk | `"in"` |
| handler's output → caller | `callPort` per chunk | `"out"` |
| either side aborts | plain `postMessage`, no reply | n/a — `{ type: "webrun-rpc:stream-abort" }` |

The `callPort` request payload is one `WireChunk`:

```ts
type WireChunk = { done: boolean; value?: Uint8Array; error?: SerializedError };
```

which is exactly `sendIterator`'s `IteratorChunk<Uint8Array>` with the error **serialised**. It is
serialised because structured clone preserves an `Error`'s `name`, `message` and `stack` but
**drops its own enumerable properties**, and conformance L4 asserts that `status: 418` and
`code: "TEAPOT"` survive the wire.

Three facts that make this work, each verified in the existing code rather than assumed:

1. **The confirmation is free.** `recieveIterator` is built on `newAsyncGenerator`, whose `next(v)`
   returns a promise resolved in the `finally` *after* the consumer's `yield` resumes — that is,
   once the consumer has pulled past the value. A `listenPort` handler that `await`s `deliver`
   therefore withholds its reply until then, and the peer's `callPort` is still waiting. G2 is
   already the behaviour of these two primitives composed; this plan does not add a mechanism, it
   removes the deadline that was breaking it (F5).
2. **The two directions cannot collide on one port.** `listenPort` reacts only to
   `type: "request"` and a matching `channelName`; `callPort`'s listener reacts only to a matching
   `channelName` *and* `callId`. Distinct channel names per direction make this explicit rather
   than merely true.
3. **The abort notice passes both filters untouched.** It has no `channelName`, so `callPort`
   ignores it, and `type !== "request"`, so `listenPort` ignores it. On a virtual port it also has
   no numeric `id`, so `structuredCodec.isEnvelope` rejects it and it can never be mistaken for a
   layer 1 envelope.

**Why not just use the existing `send` / `recieve`?** `send` is close: it is `sendIterator` +
`callPort` per chunk, with abort handling this plan reuses. It is not enough for two reasons —
it passes the error through raw (fact above), and `recieve` yields a *sequence* of streams over one
port, where a stream port carries exactly one. `throughAbort` is the part worth sharing, and Task 2
extracts it so there is one copy rather than two.

---

### Task 1: `callPort` can be given no deadline

`callPort`'s 1000 ms default is F5: it is why a consumer slower than one second per value fails a
transfer today. Spec D8 moves the deadline to the stream and defaults it to none, so `callPort`
needs a way to say "no deadline" before anything can be built on it.

**Files:**
- Modify: `packages/webrun-rpc/src/call-port.ts`
- Test: `packages/webrun-rpc/tests/call-port.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const NO_TIMEOUT: number` (value `Number.POSITIVE_INFINITY`) from
  `./call-port.js`, re-exported by the package root via the existing `export * from "./call-port.js"`.
  `CallPortOptions.timeout` keeps its type `number | undefined` and its default of `1000`; a value
  that is not a finite number greater than zero now installs no timer.

- [ ] **Step 1: Write the failing tests**

Append to `packages/webrun-rpc/tests/call-port.test.ts` (keep the file's existing imports; add
`NO_TIMEOUT` to the import from `../src/index.js`, and `listenPort` if it is not already there):

```ts
describe("callPort deadlines", () => {
  it("resolves a reply that arrives long after the 1000 ms default", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = listenPort<string, string>(channel.port2, async (params) => {
      await new Promise((r) => setTimeout(r, 1200));
      return `${params}-late`;
    });
    try {
      await expect(
        callPort<string, string>(channel.port1, "slow", { timeout: NO_TIMEOUT }),
      ).resolves.toBe("slow-late");
    } finally {
      off();
      channel.port1.close();
      channel.port2.close();
    }
  }, 10_000);

  it("still rejects at the default deadline when none is given", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = listenPort<string, string>(channel.port2, async (params) => {
      await new Promise((r) => setTimeout(r, 1200));
      return `${params}-late`;
    });
    try {
      await expect(callPort<string, string>(channel.port1, "slow")).rejects.toThrow(
        /Call timeout/,
      );
    } finally {
      off();
      channel.port1.close();
      channel.port2.close();
    }
  }, 10_000);

  it("NO_TIMEOUT does not leak a timer that keeps the process alive", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = listenPort<string, string>(channel.port2, (params) => `${params}-ok`);
    try {
      // The floor for the two assertions above: with no deadline installed a
      // normal call must still complete normally and clean up its listener.
      await expect(
        callPort<string, string>(channel.port1, "fast", { timeout: NO_TIMEOUT }),
      ).resolves.toBe("fast-ok");
    } finally {
      off();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
```

The second test is the floor for the first (G12): without it, deleting the timer entirely would
also make the first pass.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/call-port.test.ts`

Expected: the first test FAILS with `Call timeout. CallId: "call-…"`. The second and third PASS
already. Confirm vitest reports a `call-port.test.ts` file — an empty run is G9's trap.

- [ ] **Step 3: Make the deadline optional**

In `packages/webrun-rpc/src/call-port.ts`, add the export above `CallPortOptions`:

```ts
/**
 * Pass as `timeout` to install no deadline at all. Used by the stream tier,
 * where the deadline belongs to the stream rather than to one chunk (spec D8):
 * a slow consumer is throttled, never failed.
 */
export const NO_TIMEOUT = Number.POSITIVE_INFINITY;
```

Extend the `timeout` doc comment:

```ts
  /**
   * Timeout in ms after which the call rejects (default 1000). A value that is
   * not a finite number greater than zero — {@link NO_TIMEOUT}, or 0 — installs
   * no deadline, and the call then settles only on a reply, an abort, or the
   * port's close signal.
   */
  timeout?: number;
```

Replace the unconditional timer with a guarded one:

```ts
    if (Number.isFinite(timeout) && timeout > 0) {
      timerId = setTimeout(() => reject(new Error(`Call timeout. CallId: "${callId}".`)), timeout);
    }
```

Nothing else changes: the cleanup already guards `if (timerId !== undefined)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-rpc test`
Expected: PASS, +3 tests over your baseline. Then `pnpm --filter @statewalker/webrun-rpc typecheck`
and `pnpm --filter @statewalker/webrun-rpc typecheck:tests` — both exit 0 with real output.

- [ ] **Step 5: Prove the guard is load-bearing**

Per G10, copy first: `cp packages/webrun-rpc/src/call-port.ts /tmp/call-port.bak`.
Change the guard to `if (true)`. Run `pnpm --filter @statewalker/webrun-rpc test -- tests/call-port.test.ts`
and record which test fails (expected: the first, with `Call timeout`). Restore with
`cp /tmp/call-port.bak packages/webrun-rpc/src/call-port.ts` and verify with
`diff /tmp/call-port.bak packages/webrun-rpc/src/call-port.ts` (must be silent). Report the
measured result in your task report — if the mutation does **not** turn a test red, say so.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-rpc/src/call-port.ts packages/webrun-rpc/tests/call-port.test.ts
git commit -m "feat(rpc): callPort accepts NO_TIMEOUT, so a deadline is optional

Spec D8 moves the deadline from the chunk to the stream and defaults it to
none. A finite positive timeout still installs the timer and the 1000 ms
default is unchanged, so no existing caller moves."
```

---

### Task 2: `duplexOverPort` and `serveDuplexOverPort` — the data path

The stream tier's happy path: bytes in one end, the same bytes out the other, in both directions,
with half-close and error propagation. Cancellation and timeouts are Tasks 3 and 4.

**Files:**
- Create: `packages/webrun-rpc/src/through-abort.ts`
- Modify: `packages/webrun-rpc/src/send.ts` (delete the local `throughAbort`, import it instead)
- Create: `packages/webrun-rpc/src/duplex-over-port.ts`
- Modify: `packages/webrun-rpc/src/index.ts`
- Test: `packages/webrun-rpc/tests/duplex-over-port.test.ts`

**Interfaces:**
- Consumes: `NO_TIMEOUT` and `callPort` from `./call-port.js` (Task 1); `listenPort` from
  `./listen-port.js`; `MessageTarget` from `./message-target.js`; and from
  `@statewalker/webrun-streams`: `Duplex`, `sendIterator`, `recieveIterator`, `toChunks`,
  `serializeError`, `deserializeError`, `SerializedError`, `ChunkReceiver`.
- Produces, from `./duplex-over-port.js` and re-exported by the package root:
  - `export interface DuplexOverPortOptions { maxMessageSize?: number; timeout?: number; log?: (...args: unknown[]) => void }`
  - `export function duplexOverPort(port: MessageTarget, options?: DuplexOverPortOptions): Duplex`
  - `export function serveDuplexOverPort(port: MessageTarget, handler: Duplex, options?: DuplexOverPortOptions): () => void`
  - `export const STREAM_ABORT = "webrun-rpc:stream-abort"` — the abort notice's `type`, exported so
    tests and Plan C can assert on it.
  `timeout` is accepted in this task and **not yet honoured**; Task 4 implements it. Say so in the
  doc comment rather than leaving a silent no-op.
- Also produces: `throughAbort` from `./through-abort.js`, **not** exported from the package root —
  it is an internal helper shared by `send.ts` and `duplex-over-port.ts`.

- [ ] **Step 1: Move `throughAbort` into its own module**

Create `packages/webrun-rpc/src/through-abort.ts` containing the `throughAbort` function currently
at the bottom of `src/send.ts`, **byte-for-byte including its doc comment**, with `export` added:

```ts
/**
 * Wraps an async iterable so that an `AbortSignal` firing causes the wrapper
 * to return cleanly, forwarding `return()` to the underlying iterator so the
 * producer (e.g., a user-supplied generator) sees its own `finally` blocks
 * run immediately rather than waiting for the next yield.
 */
export async function* throughAbort<T>(
  input: AsyncIterable<T> | Iterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iter = (input as AsyncIterable<T>)[Symbol.asyncIterator]
    ? (input as AsyncIterable<T>)[Symbol.asyncIterator]()
    : ((input as Iterable<T>)[Symbol.iterator]() as unknown as AsyncIterator<T>);
  const onAbort = () => {
    void iter.return?.(undefined as never);
  };
  if (signal.aborted) {
    void iter.return?.(undefined as never);
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const r = await iter.next();
      if (r.done) return;
      if (signal.aborted) return;
      yield r.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
```

In `src/send.ts`, delete that function and add `import { throughAbort } from "./through-abort.js";`
below the existing imports.

- [ ] **Step 2: Verify the move changed no behaviour**

Run: `pnpm --filter @statewalker/webrun-rpc test`
Expected: PASS with the **same** test count as after Task 1 — this step moves code and adds none.
Then `pnpm --filter @statewalker/webrun-rpc typecheck` and `typecheck:tests`, both exit 0.

Commit this separately so the refactor is reviewable on its own:

```bash
git add packages/webrun-rpc/src/through-abort.ts packages/webrun-rpc/src/send.ts
git commit -m "refactor(rpc): extract throughAbort so both senders share one copy

The stream tier needs the same abort-forwarding wrapper send.ts has. Moving
it is the alternative to a second copy."
```

- [ ] **Step 3: Write the failing tests**

Create `packages/webrun-rpc/tests/duplex-over-port.test.ts`:

```ts
import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { duplexOverPort, serveDuplexOverPort } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A caller/handler pair over one real MessageChannel — one stream, one port. */
function streamPair(handler: Duplex, options: { maxMessageSize?: number } = {}) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const off = serveDuplexOverPort(channel.port2, handler, options);
  const call = duplexOverPort(channel.port1, options);
  return {
    call,
    close() {
      off();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const echo: Duplex = async function* echo(input) {
  for await (const chunk of input) yield chunk;
};

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

function pair(handler: Duplex, options: { maxMessageSize?: number } = {}) {
  const p = streamPair(handler, options);
  open.push(p);
  return p;
}

describe("duplexOverPort — data path", () => {
  it("round-trips a small body through an echo handler", async () => {
    const { call } = pair(echo);
    const out = await collectBytes(call([enc.encode("hello stream")]));
    expect(dec.decode(out)).toBe("hello stream");
  });

  it("round-trips an empty body", async () => {
    const { call } = pair(echo);
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(out.byteLength).toBe(0);
  });

  it("splits a body larger than maxMessageSize and reassembles it intact", async () => {
    // R3: the LiveKit failure this guards against delivered a 1 MiB body as
    // zero bytes with no error on either side. The count assertion is the
    // ceiling; byteLength and the content check are its floor.
    const seen: number[] = [];
    const counting: Duplex = async function* counting(input) {
      for await (const chunk of input) {
        seen.push(chunk.byteLength);
        yield chunk;
      }
    };
    const size = 100 * 1024;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i & 0xff;

    const { call } = pair(counting, { maxMessageSize: 4096 });
    const out = await collectBytes(call([body]));

    expect(out.byteLength).toBe(size);
    expect(out[0]).toBe(0);
    expect(out[size - 1]).toBe((size - 1) & 0xff);
    expect(seen.length).toBe(Math.ceil(size / 4096));
    expect(Math.max(...seen)).toBeLessThanOrEqual(4096);
  });

  it("keeps yielding after the caller's input exhausts (half-close)", async () => {
    const lateResponder: Duplex = async function* lateResponder(input) {
      for await (const _ of input) {
        /* drain */
      }
      yield enc.encode("a");
      await new Promise((r) => setTimeout(r, 30));
      yield enc.encode("b");
      await new Promise((r) => setTimeout(r, 30));
      yield enc.encode("c");
    };
    const { call } = pair(lateResponder);
    const out = await collectBytes(
      call(
        (async function* () {
          yield enc.encode("ping");
        })(),
      ),
    );
    expect(dec.decode(out)).toBe("abc");
  });

  it("carries a handler error across the wire with its custom fields and stack", async () => {
    const failing: Duplex = async function* failing() {
      const err = new Error("intentional failure");
      Object.assign(err, { status: 418, code: "TEAPOT" });
      if ((0 as number) === 0) throw err;
      yield new Uint8Array(0);
    };
    const { call } = pair(failing);
    let caught: unknown;
    try {
      await collectBytes(call([new Uint8Array(0)]));
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      message: "intentional failure",
      status: 418,
      code: "TEAPOT",
    });
    expect(typeof (caught as Error).stack).toBe("string");
    expect(((caught as Error).stack ?? "").length).toBeGreaterThan(0);
  });

  it("carries a caller-side input error to the handler", async () => {
    let handlerSaw: unknown;
    const catching: Duplex = async function* catching(input) {
      try {
        for await (const _ of input) {
          /* drain */
        }
      } catch (e) {
        handlerSaw = e;
      }
      yield enc.encode("done");
    };
    const { call } = pair(catching);
    const out = await collectBytes(
      call(
        (async function* () {
          yield enc.encode("one");
          const err = new Error("producer blew up");
          Object.assign(err, { code: "PRODUCER" });
          throw err;
        })(),
      ),
    );
    expect(dec.decode(out)).toBe("done");
    expect(handlerSaw).toMatchObject({ message: "producer blew up", code: "PRODUCER" });
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port.test.ts`
Expected: FAIL at import — `duplexOverPort` / `serveDuplexOverPort` are not exported.

- [ ] **Step 5: Implement the stream tier**

Create `packages/webrun-rpc/src/duplex-over-port.ts`:

```ts
import {
  type ChunkReceiver,
  deserializeError,
  type Duplex,
  recieveIterator,
  sendIterator,
  type SerializedError,
  serializeError,
  toChunks,
} from "@statewalker/webrun-streams";
import { callPort, NO_TIMEOUT } from "./call-port.js";
import { listenPort } from "./listen-port.js";
import type { MessageTarget } from "./message-target.js";
import { throughAbort } from "./through-abort.js";

/**
 * The `type` of the out-of-band notice a side posts when it abandons a stream.
 *
 * Layer 1's `close` is not observable to layer 2 — a closed virtual port drops
 * its listeners silently and is indistinguishable from a working port nobody
 * is answering — so the peer would otherwise wait forever. Exported because
 * tests and adapters assert on it.
 */
export const STREAM_ABORT = "webrun-rpc:stream-abort";

/** Caller's input travels on this channel; the handler listens on it. */
const CHANNEL_IN = "in";
/** The handler's output travels on this channel; the caller listens on it. */
const CHANNEL_OUT = "out";

/** One chunk on the wire: `IteratorChunk<Uint8Array>` with the error serialised. */
interface WireChunk {
  done: boolean;
  value?: Uint8Array;
  error?: SerializedError;
}

export interface DuplexOverPortOptions {
  /**
   * Largest payload one chunk may carry, from `PortMux.maxMessageSize` (spec
   * D10). Bodies are split to fit with `toChunks`. Unset means no limit and no
   * splitting.
   */
  maxMessageSize?: number;
  /**
   * Inactivity timeout for the whole stream, in ms. Unset — the default —
   * means no timeout at all (spec D8): a slow consumer is throttled, never
   * failed.
   */
  timeout?: number;
  /** Logging function; defaults to a no-op. */
  log?: (...args: unknown[]) => void;
}

/**
 * One port in, one `Duplex` out (spec D9).
 *
 * The returned `Duplex` runs a single stream on `port`: the caller's `input`
 * is sent chunk by chunk with `callPort`, and the handler's output arrives the
 * same way on the other channel. Within each direction the next chunk is never
 * sent until the previous one has been delivered *and* pulled past by the
 * consumer (spec D11) — the reply to a chunk call *is* the confirmation, and
 * `listenPort` withholds it until then.
 *
 * A stream port carries exactly one invocation. To make several calls, open
 * several ports: `mux.openPort({ kind: "stream" })` per call.
 */
export function duplexOverPort(port: MessageTarget, options: DuplexOverPortOptions = {}): Duplex {
  return (input) => runCallerSide(port, input, options);
}

/**
 * Installs `handler` as the serving side of one stream on `port`. Returns an
 * idempotent teardown that abandons the stream and notifies the peer.
 */
export function serveDuplexOverPort(
  port: MessageTarget,
  handler: Duplex,
  options: DuplexOverPortOptions = {},
): () => void {
  const controller = new AbortController();
  const notice = installAbortNotice(port, controller);
  const inbound = receiveChunks(port, CHANNEL_IN, controller);
  let output: AsyncGenerator<Uint8Array>;
  try {
    output = handler(inbound.stream);
  } catch (err) {
    // A handler that throws before returning a generator still owes the peer
    // an end-of-stream, or its `callPort` never settles.
    void sendChunks(port, CHANNEL_OUT, failing(err), options, controller.signal).catch(() => {});
    return teardownOnce(port, controller, notice, inbound, undefined);
  }
  const pump = sendChunks(port, CHANNEL_OUT, output, options, controller.signal);
  void pump.catch(() => {
    // Reported to the peer inside sendChunks; nothing to surface locally.
  });
  return teardownOnce(port, controller, notice, inbound, output);
}

async function* failing(err: unknown): AsyncGenerator<Uint8Array> {
  if ((0 as number) === 0) throw err;
  yield new Uint8Array(0);
}

function teardownOnce(
  port: MessageTarget,
  controller: AbortController,
  notice: { post(): void; stop(): void },
  inbound: { stop(): void },
  output: AsyncGenerator<Uint8Array> | undefined,
): () => void {
  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    if (!controller.signal.aborted) controller.abort(new Error("webrun-rpc: stream torn down"));
    notice.post();
    notice.stop();
    inbound.stop();
    void output?.return(undefined as never).catch(() => {});
  };
}

function runCallerSide(
  port: MessageTarget,
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: DuplexOverPortOptions,
): AsyncGenerator<Uint8Array> {
  const controller = new AbortController();
  const notice = installAbortNotice(port, controller);
  const inbound = receiveChunks(port, CHANNEL_OUT, controller);
  const pump = sendChunks(port, CHANNEL_IN, input, options, controller.signal);
  void pump.catch(() => {
    // The outbound half's failure surfaces to the peer, not to this consumer:
    // the consumer's contract is the inbound half.
  });

  return (async function* () {
    try {
      yield* inbound.stream;
    } finally {
      // Abort BEFORE awaiting the pump. `callPort` runs with NO_TIMEOUT here,
      // so an un-aborted in-flight chunk call would never settle and this
      // `finally` would deadlock — which is exactly the defect found in the
      // -webrtc adapter, where the outbound half was awaited unconditionally.
      if (!controller.signal.aborted) {
        controller.abort(new Error("webrun-rpc: the caller abandoned the stream"));
      }
      notice.post();
      notice.stop();
      inbound.stop();
      await pump.catch(() => {});
      try {
        await port.close?.();
      } catch {
        /* the port may already be gone; nothing to unwind */
      }
    }
  })();
}

/**
 * Listens for the peer's abort notice, and can post our own. The notice is a
 * plain message with no `channelName` and a `type` that is not `"request"`,
 * so neither `callPort` nor `listenPort` reacts to it, and it carries no
 * numeric `id`, so `structuredCodec` never mistakes it for a layer 1 envelope.
 */
function installAbortNotice(
  port: MessageTarget,
  controller: AbortController,
): { post(): void; stop(): void } {
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | undefined;
    if (!data || data.type !== STREAM_ABORT) return;
    if (!controller.signal.aborted) {
      controller.abort(new Error("webrun-rpc: the peer abandoned the stream"));
    }
  };
  port.addEventListener("message", onMessage);
  let posted = false;
  return {
    post() {
      if (posted) return;
      posted = true;
      try {
        port.postMessage({ type: STREAM_ABORT });
      } catch {
        /* the port is already gone — the peer needs no notice */
      }
    },
    stop() {
      port.removeEventListener("message", onMessage);
    },
  };
}

/**
 * The receiving half of one direction.
 *
 * The `listenPort` listener is installed **eagerly**, not lazily inside
 * `recieveIterator`'s installer, because a handler that never drains its input
 * would otherwise leave the peer's chunk calls with nobody to answer them. If
 * the local consumer has not started iterating, an inbound chunk waits for it —
 * which is the correct backpressure, and different from having no listener.
 */
function receiveChunks(
  port: MessageTarget,
  channelName: string,
  controller: AbortController,
): { stream: AsyncGenerator<Uint8Array>; stop(): void } {
  let deliver: ChunkReceiver<Uint8Array> | undefined;
  const waiting: Array<() => void> = [];
  let finished = false;

  const ready = (): Promise<void> =>
    deliver || finished ? Promise.resolve() : new Promise<void>((r) => waiting.push(r));

  const wake = () => {
    for (const r of waiting.splice(0)) r();
  };

  const off = listenPort<WireChunk, void>(
    port,
    async ({ done, value, error }) => {
      await ready();
      if (finished) throw new Error("webrun-rpc: the stream is closed");
      await deliver?.({
        done,
        value,
        error: error ? deserializeError(error) : undefined,
      });
    },
    { channelName },
  );

  const onAbort = () => {
    finished = true;
    wake();
    void deliver?.({ done: true, error: controller.signal.reason });
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const stream = recieveIterator<Uint8Array>((d) => {
    deliver = d;
    wake();
    return () => {
      finished = true;
      wake();
      off();
      controller.signal.removeEventListener("abort", onAbort);
    };
  });

  return {
    stream,
    stop() {
      finished = true;
      wake();
      off();
      controller.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * The sending half of one direction: one `callPort` per chunk, one call
 * outstanding at a time (spec D11/D12), with no per-chunk deadline (spec D8).
 */
async function sendChunks(
  port: MessageTarget,
  channelName: string,
  output: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  { maxMessageSize, log }: DuplexOverPortOptions,
  signal: AbortSignal,
): Promise<void> {
  const framed = maxMessageSize ? toChunks(maxMessageSize)(output) : output;
  const stream = throughAbort(framed, signal);
  try {
    await sendIterator<Uint8Array>(async ({ done, value, error }) => {
      if (signal.aborted) return;
      const chunk: WireChunk = {
        done,
        value,
        error: error === undefined ? undefined : serializeError(error),
      };
      log?.("[duplexOverPort] send", { channelName, done, size: value?.byteLength });
      await callPort<void, WireChunk>(port, chunk, {
        channelName,
        timeout: NO_TIMEOUT,
        signal,
      });
    }, stream);
  } catch (err) {
    // An abort is the expected way this ends when the local side walks away;
    // anything else is a genuine transport failure worth surfacing.
    if (signal.aborted) return;
    throw err;
  }
}
```

Then add to `packages/webrun-rpc/src/index.ts`, keeping the file's alphabetical ordering:

```ts
export * from "./duplex-over-port.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port.test.ts`
Expected: PASS, 6 tests.

Then the whole package: `pnpm --filter @statewalker/webrun-rpc test`, plus `typecheck` and
`typecheck:tests`, and `pnpm --filter @statewalker/webrun-rpc lint`. All exit 0 with real output.

- [ ] **Step 7: Measure two mutations**

Both per G10 — `cp` to `/tmp` first, `cp` back, verify with `diff`.

| mutation | predicted killer |
| --- | --- |
| in `sendChunks`, drop the `serializeError` call and send `error` raw | the custom-fields test (`status`/`code` lost to structured clone) |
| in `sendChunks`, delete the `maxMessageSize ? toChunks(...) : output` framing | the chunk-splitting test (`seen.length` becomes 1) |

Record what each mutation **actually** killed. A prediction that misses is the finding, not a
failure — report the discrepancy.

- [ ] **Step 8: Commit**

```bash
git add packages/webrun-rpc/src/duplex-over-port.ts packages/webrun-rpc/src/index.ts \
        packages/webrun-rpc/tests/duplex-over-port.test.ts
git commit -m "feat(rpc): duplexOverPort — one Duplex over one port

Each direction is a callPort per chunk on its own channelName; the reply is
the confirmation and listenPort withholds it until the consumer has pulled
past the value, so a producer can never run more than one chunk ahead
(spec D11/D12). Errors are serialised explicitly because structured clone
drops an Error's own enumerable properties.

Cancellation and the per-stream timeout land in the next two tasks; the
timeout option is accepted and documented as not yet honoured."
```

---

### Task 3: cancellation and teardown

Layer 1's close is invisible to layer 2 (Plan A finding 2), so an abandoned stream must say so
explicitly. This task makes a caller's `break` run the handler's `finally`, and a handler's
teardown wake the caller.

**Files:**
- Modify: `packages/webrun-rpc/src/duplex-over-port.ts` (only if a test proves something missing)
- Test: `packages/webrun-rpc/tests/duplex-over-port-cancel.test.ts`

**Interfaces:**
- Consumes: `duplexOverPort`, `serveDuplexOverPort`, `STREAM_ABORT` from `../src/index.js` (Task 2);
  `multiplexPort`, `structuredCodec` from the same root.
- Produces: no new API. If Task 2's implementation already satisfies every test here, that is the
  expected outcome and the deliverable is the tests plus the measured mutations — say so plainly
  rather than inventing a change.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-rpc/tests/duplex-over-port-cancel.test.ts`:

```ts
import type { Duplex } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  multiplexPort,
  serveDuplexOverPort,
  STREAM_ABORT,
  structuredCodec,
} from "../src/index.js";

const enc = new TextEncoder();

/** Poll a condition rather than waiting a fixed number of ticks (G13). */
async function waitFor(label: string, cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

function streamPair(handler: Duplex) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const off = serveDuplexOverPort(channel.port2, handler);
  open.push(() => {
    off();
    channel.port1.close();
    channel.port2.close();
  });
  return { call: duplexOverPort(channel.port1), channel };
}

describe("duplexOverPort — cancellation", () => {
  it("a caller that stops iterating runs the handler's finally", async () => {
    let cleanupRan = false;
    const unbounded: Duplex = async function* unbounded() {
      try {
        while (true) {
          yield enc.encode("tick");
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        cleanupRan = true;
      }
    };
    const { call } = streamPair(unbounded);
    let count = 0;
    for await (const _ of call([new Uint8Array(0)])) {
      count++;
      if (count >= 3) break;
    }
    await waitFor("handler cleanup after caller break", () => cleanupRan);
    expect(count).toBe(3);
    expect(cleanupRan).toBe(true);
  });

  it("posts the abort notice on the port rather than relying on close", async () => {
    // The ceiling: the notice is observable on the wire. Its floor is the test
    // above — the handler's finally actually ran because of it.
    const seen: unknown[] = [];
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    channel.port2.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as { type?: unknown } | undefined;
      if (data?.type === STREAM_ABORT) seen.push(data);
    });
    const off = serveDuplexOverPort(
      channel.port2,
      async function* () {
        while (true) {
          yield enc.encode("tick");
          await new Promise((r) => setTimeout(r, 10));
        }
      },
    );
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    let n = 0;
    for await (const _ of duplexOverPort(channel.port1)([new Uint8Array(0)])) {
      if (++n >= 2) break;
    }
    await waitFor("abort notice on the wire", () => seen.length > 0);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a handler teardown wakes a caller that is still reading", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(
      channel.port2,
      async function* () {
        while (true) {
          yield enc.encode("tick");
          await new Promise((r) => setTimeout(r, 10));
        }
      },
    );
    open.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    let ended = false;
    let failed: unknown;
    const consumer = (async () => {
      try {
        for await (const _ of duplexOverPort(channel.port1)([new Uint8Array(0)])) {
          /* read until the peer goes away */
        }
      } catch (e) {
        failed = e;
      } finally {
        ended = true;
      }
    })();
    await new Promise((r) => setTimeout(r, 40));
    off();
    await waitFor("caller woke after handler teardown", () => ended);
    await consumer;
    // Either outcome is correct — the stream ended, cleanly or with the
    // abandonment error. What must not happen is hanging forever.
    expect(ended).toBe(true);
    if (failed) expect(String(failed)).toMatch(/abandoned|closed|torn/);
  });

  it("teardown is idempotent", () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(channel.port2, async function* () {
      yield enc.encode("x");
    });
    open.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    expect(() => {
      off();
      off();
      off();
    }).not.toThrow();
  });

  it("cancelling one stream over a mux leaves another stream working", async () => {
    // The isolation floor for every teardown assertion above.
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const serverMux = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (p) => {
        serveDuplexOverPort(p, async function* echoOrTick(input) {
          for await (const chunk of input) yield chunk;
          while (true) {
            yield enc.encode("tick");
            await new Promise((r) => setTimeout(r, 10));
          }
        });
      },
    });
    const clientMux = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
    });
    open.push(() => {
      void clientMux.close();
      void serverMux.close();
    });

    const first = duplexOverPort(await clientMux.openPort({ kind: "stream" }));
    let n = 0;
    for await (const _ of first([enc.encode("a")])) {
      if (++n >= 1) break;
    }

    const second = duplexOverPort(await clientMux.openPort({ kind: "stream" }));
    const chunks: string[] = [];
    for await (const chunk of second([enc.encode("still-here")])) {
      chunks.push(new TextDecoder().decode(chunk));
      break;
    }
    expect(chunks[0]).toBe("still-here");
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-cancel.test.ts`

Expected: Task 2's implementation should satisfy most of these. Record **exactly** which pass and
which fail before changing anything — that record is what tells a reviewer whether this task added
coverage or added behaviour.

- [ ] **Step 3: Fix whatever failed**

Only touch `src/duplex-over-port.ts`, and only for a test that actually failed. The two failures to
expect, with their fixes:

*If the caller's `break` does not run the handler's `finally`:* the abort notice is arriving but the
handler's `output.return()` is not being called. `serveDuplexOverPort`'s abort path must forward the
abort into the output generator. `sendChunks` already wraps `output` in `throughAbort`, which calls
`iter.return()` on abort — verify `installAbortNotice` is actually firing `controller.abort()` on
the serving side, and that `serveDuplexOverPort` installs it before `handler(...)` runs.

*If the handler teardown does not wake the caller:* `teardownOnce` posts the notice, but the caller's
`receiveChunks` must translate its own `controller.abort()` into an end-of-stream for the local
consumer. That is the `onAbort` handler calling `deliver({ done: true, error: signal.reason })`.
Check it is registered before the consumer starts iterating.

If a third failure appears that neither paragraph covers, that is a genuine finding: describe it,
fix it minimally, and say so in your report.

- [ ] **Step 4: Run everything**

Run: `pnpm --filter @statewalker/webrun-rpc test`, then `typecheck`, `typecheck:tests`, `lint`.
Expected: PASS, +5 tests over Task 2.

- [ ] **Step 5: Measure the mutation that matters**

Per G10. In `src/duplex-over-port.ts`, make `installAbortNotice`'s `post()` a no-op:

```ts
    post() {
      /* mutation: never notify the peer */
    },
```

Run `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-cancel.test.ts`.
Prediction: the first two tests fail — the handler's `finally` never runs, and no notice reaches the
wire. Restore and `diff`. Report the measured result.

This mutation is the whole argument that Plan A finding 2 is real: if the tests stay green with
`post()` gutted, then layer 1's close *is* observable after all, and the plan's premise is wrong.
Say so if that happens.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-rpc/src/duplex-over-port.ts \
        packages/webrun-rpc/tests/duplex-over-port-cancel.test.ts
git commit -m "feat(rpc): explicit stream-abort notice, since layer 1's close is invisible

A closed virtual port drops its listeners silently and is indistinguishable
from a working port nobody is answering (Plan A finding 2), so an abandoned
stream tells the peer out of band. Proven load-bearing: gutting the notice
leaves the handler's finally unrun."
```

---

### Task 4: the stream timeout, and the F5 regression

Spec D8 gives a stream one timeout that defaults to none. The headline assertion is the F5
regression: a consumer deliberately slower than the old 1000 ms per-chunk default completes a
transfer, which **fails on today's code**.

**Files:**
- Modify: `packages/webrun-rpc/src/duplex-over-port.ts`
- Test: `packages/webrun-rpc/tests/duplex-over-port-timeout.test.ts`

**Interfaces:**
- Consumes: `duplexOverPort`, `serveDuplexOverPort`, `DuplexOverPortOptions` from Task 2.
- Produces: `DuplexOverPortOptions.timeout` is now honoured — an **inactivity** timeout. The clock
  is reset by any chunk sent or received in either direction; elapsing aborts the stream with an
  `Error` whose message matches `/webrun-rpc: stream idle for \d+ ms/`. Unset, zero, or non-finite
  means no timeout, matching `callPort`'s `NO_TIMEOUT` convention from Task 1.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-rpc/tests/duplex-over-port-timeout.test.ts`:

```ts
import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { duplexOverPort, type DuplexOverPortOptions, serveDuplexOverPort } from "../src/index.js";

const enc = new TextEncoder();

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

function streamPair(handler: Duplex, options: DuplexOverPortOptions = {}) {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  const off = serveDuplexOverPort(channel.port2, handler, options);
  open.push(() => {
    off();
    channel.port1.close();
    channel.port2.close();
  });
  return duplexOverPort(channel.port1, options);
}

describe("duplexOverPort — the stream timeout (spec D8)", () => {
  it("F5: a consumer slower than the old 1000 ms default completes the transfer", async () => {
    // This is the regression that D8 exists for. It fails on the pre-B2 stack,
    // where every chunk carried callPort's 1000 ms deadline.
    const call = streamPair(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });
    const received: string[] = [];
    for await (const chunk of call([enc.encode("one"), enc.encode("two")])) {
      await new Promise((r) => setTimeout(r, 1200));
      received.push(new TextDecoder().decode(chunk));
    }
    expect(received.join("")).toBe("onetwo");
  }, 20_000);

  it("aborts a stream whose peer stalls past the configured timeout", async () => {
    let cleanupRan = false;
    const call = streamPair(
      async function* stalling(input) {
        try {
          for await (const _ of input) {
            /* drain */
          }
          await new Promise((r) => setTimeout(r, 5000));
          yield enc.encode("too late");
        } finally {
          cleanupRan = true;
        }
      },
      { timeout: 150 },
    );
    await expect(collectBytes(call([enc.encode("hi")]))).rejects.toThrow(
      /webrun-rpc: stream idle for 150 ms/,
    );
    expect(cleanupRan).toBe(true);
  }, 20_000);

  it("progress resets the clock: many slow-but-steady chunks complete", async () => {
    // The floor for the assertion above. Each gap is under the timeout, the
    // total is many times over it, and a non-resetting timer kills this.
    const call = streamPair(
      async function* steady() {
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 60));
          yield enc.encode(String(i));
        }
      },
      { timeout: 250 },
    );
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(new TextDecoder().decode(out)).toBe("01234567");
  }, 20_000);

  it("no timeout by default: a 1.5 s stall is not an error", async () => {
    const call = streamPair(async function* slowStart() {
      await new Promise((r) => setTimeout(r, 1500));
      yield enc.encode("eventually");
    });
    const out = await collectBytes(call([new Uint8Array(0)]));
    expect(new TextDecoder().decode(out)).toBe("eventually");
  }, 20_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-timeout.test.ts`
Expected: tests 1, 3 and 4 PASS (Task 1 already removed the per-chunk deadline); test 2 FAILS
because `timeout` is accepted and ignored — `collectBytes` resolves after ~5 s instead of rejecting.

Record this: **if test 1 fails, stop and report it** — it means the per-chunk deadline is still in
play somewhere and Task 1 did not do what it claimed.

- [ ] **Step 3: Implement the inactivity watchdog**

In `src/duplex-over-port.ts`, add the helper below `installAbortNotice`:

```ts
/**
 * The per-stream inactivity timeout (spec D8). Reset by any chunk in either
 * direction; elapsing aborts the stream. Unset, zero or non-finite installs no
 * timer at all, which is the default: a slow consumer is throttled, not failed.
 */
function installStreamTimeout(
  controller: AbortController,
  timeout: number | undefined,
): { touch(): void; stop(): void } {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) {
    return { touch() {}, stop() {} };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`webrun-rpc: stream idle for ${timeout} ms`));
      }
    }, timeout);
  };
  arm();
  return {
    touch() {
      if (timer !== undefined) clearTimeout(timer);
      arm();
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
```

Thread it through. `sendChunks` gains a `touch` parameter:

```ts
async function sendChunks(
  port: MessageTarget,
  channelName: string,
  output: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  { maxMessageSize, log }: DuplexOverPortOptions,
  signal: AbortSignal,
  touch: () => void,
): Promise<void> {
```

and calls `touch()` immediately after each successful `await callPort(...)`.

`receiveChunks` gains the same parameter and calls `touch()` at the top of its `listenPort` handler,
before `await ready()` — inbound traffic is progress even if the local consumer has not pulled yet.

`runCallerSide` and `serveDuplexOverPort` each create one clock and share it across both halves:

```ts
  const clock = installStreamTimeout(controller, options.timeout);
```

passing `clock.touch` to both `receiveChunks` and `sendChunks`, and calling `clock.stop()` in the
same place they call `notice.stop()`.

Finally, update the `timeout` doc comment in `DuplexOverPortOptions` — delete the "not yet honoured"
sentence Task 2 added and replace it with:

```ts
  /**
   * Inactivity timeout for the whole stream, in ms: the clock is reset by any
   * chunk in either direction, and elapsing aborts the stream. Unset — the
   * default — means no timeout at all (spec D8): a slow consumer is throttled,
   * never failed. Any finite default would reintroduce F5 at a different
   * threshold.
   */
  timeout?: number;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-timeout.test.ts`
Expected: PASS, 4 tests. Then the whole package plus `typecheck`, `typecheck:tests`, `lint`.

- [ ] **Step 5: Measure two mutations**

Per G10.

| mutation | predicted killer |
| --- | --- |
| delete the `touch()` call in `sendChunks` and in `receiveChunks` (make `touch` a no-op at both call sites) | "progress resets the clock" — 8 × 60 ms exceeds a non-resetting 250 ms timer |
| change `installStreamTimeout`'s guard to `if (false)` so a timer is always armed with `timeout ?? 0` | "no timeout by default" — a 1.5 s stall now aborts |

Record what each actually killed.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-rpc/src/duplex-over-port.ts \
        packages/webrun-rpc/tests/duplex-over-port-timeout.test.ts
git commit -m "feat(rpc): the stream carries the timeout, and it defaults to none

Spec D8. The clock is per stream and resets on progress in either direction;
unset means no deadline at all, because any finite default reintroduces F5 at
a different threshold. Headline test: a consumer 1200 ms per chunk completes
a transfer, which fails on the pre-B2 stack."
```

---

### Task 5: window enforcement, and the hostile questions at layer 2

Spec D15: a second unconfirmed chunk is a protocol violation. This is the layer-2 answer to the
questions `emulateMux`'s 19-test hostile suite asks — and the reason no byte ceiling is needed.

Note for the record: the `emulateMux` hostile suite in
`packages/webrun-streams/tests/emulate-mux-hostile.test.ts` **stays where it is** (G7). It tests a
wire format that still exists. Plan C deletes it with `emulateMux`. This task writes the layer-2
answers to the same questions; it does not move or delete anything.

**Files:**
- Modify: `packages/webrun-rpc/src/duplex-over-port.ts`
- Test: `packages/webrun-rpc/tests/duplex-over-port-hostile.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: no new option (G4 — there is no `maxBufferedBytes`). Behaviour: a second chunk request
  arriving on a stream's inbound channel while the previous one is still unconfirmed causes the
  offending `callPort` to reject with a message matching
  `/webrun-rpc: peer sent a second unconfirmed chunk/`, the local stream to fail with the same
  error, and the port to be closed. Subsequent chunks on that port are rejected with the same error.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-rpc/tests/duplex-over-port-hostile.test.ts`:

```ts
import type { Duplex } from "@statewalker/webrun-streams";
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import { duplexOverPort, multiplexPort, serveDuplexOverPort, structuredCodec } from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

const echo: Duplex = async function* echo(input) {
  for await (const chunk of input) yield chunk;
};

describe("duplexOverPort — a peer that ignores the protocol (spec D15)", () => {
  it("refuses a second unconfirmed chunk and closes that port", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    // A handler that never drains its input, so the first chunk stays
    // unconfirmed for as long as the test needs.
    const off = serveDuplexOverPort(channel.port2, async function* stalled() {
      await new Promise((r) => setTimeout(r, 5000));
    });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });

    const replies: Array<{ type: string; error?: { message?: string } }> = [];
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as
        | { type?: string; error?: { message?: string } }
        | undefined;
      if (data?.type === "response:error" || data?.type === "response:result") {
        replies.push(data as { type: string; error?: { message?: string } });
      }
    });

    // Hand-rolled hostile sender: two chunk requests, no waiting.
    channel.port1.postMessage({
      type: "request",
      channelName: "in",
      callId: "hostile-1",
      params: { done: false, value: enc.encode("first") },
    });
    channel.port1.postMessage({
      type: "request",
      channelName: "in",
      callId: "hostile-2",
      params: { done: false, value: enc.encode("second") },
    });

    await waitFor("a refusal came back", () => replies.some((r) => r.type === "response:error"));
    const refusal = replies.find((r) => r.type === "response:error");
    expect(refusal?.error?.message).toMatch(/second unconfirmed chunk/);
  }, 20_000);

  it("a cooperative sender is never refused, however many chunks it sends", async () => {
    // The floor (G12): the rule above must not be satisfiable by refusing
    // everything. 200 chunks in strict sequence must all get through.
    const size = 200 * 512;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i & 0xff;
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(channel.port2, echo, { maxMessageSize: 512 });
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    const out = await collectBytes(
      duplexOverPort(channel.port1, { maxMessageSize: 512 })([body]),
    );
    expect(out.byteLength).toBe(size);
    expect(out[size - 1]).toBe((size - 1) & 0xff);
  }, 30_000);

  it("the penalty is scoped to the offending port; the mux still serves", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const serverMux = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (p, meta) => {
        if ((meta as { kind?: string } | undefined)?.kind === "stalled") {
          serveDuplexOverPort(p, async function* () {
            await new Promise((r) => setTimeout(r, 5000));
          });
        } else {
          serveDuplexOverPort(p, echo);
        }
      },
    });
    const clientMux = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
    });
    open.push(() => {
      void clientMux.close();
      void serverMux.close();
    });

    const hostilePort = await clientMux.openPort({ kind: "stalled" });
    hostilePort.postMessage({
      type: "request",
      channelName: "in",
      callId: "h1",
      params: { done: false, value: enc.encode("a") },
    });
    hostilePort.postMessage({
      type: "request",
      channelName: "in",
      callId: "h2",
      params: { done: false, value: enc.encode("b") },
    });
    await new Promise((r) => setTimeout(r, 60));

    const goodPort = await clientMux.openPort({ kind: "stream" });
    const out = await collectBytes(duplexOverPort(goodPort)([enc.encode("unaffected")]));
    expect(dec.decode(out)).toBe("unaffected");
  }, 20_000);

  it("garbage on a stream port is ignored and the stream still works", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    const off = serveDuplexOverPort(channel.port2, echo);
    open.push(() => {
      off();
      channel.port1.close();
      channel.port2.close();
    });
    for (const junk of [
      undefined,
      null,
      42,
      "a string",
      { type: "request" },
      { type: "request", channelName: "in" },
      { type: "nonsense", channelName: "in", callId: "x", params: {} },
      { type: "response:result", channelName: "in", callId: "never-sent", result: 1 },
    ]) {
      channel.port1.postMessage(junk);
    }
    const out = await collectBytes(duplexOverPort(channel.port1)([enc.encode("still-works")]));
    expect(dec.decode(out)).toBe("still-works");
  }, 20_000);
});
```

- [ ] **Step 2: Run them to verify the first fails**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-hostile.test.ts`
Expected: the first test FAILS — no refusal comes back, because nothing enforces the window yet.
Tests 2 and 4 should already PASS. Record the actual result for test 3.

- [ ] **Step 3: Enforce the window in `receiveChunks`**

In `src/duplex-over-port.ts`, add two variables inside `receiveChunks` beside `finished`:

```ts
  let outstanding = false;
  let poison: Error | undefined;
```

and replace the `listenPort` handler body with:

```ts
    async ({ done, value, error }) => {
      touch();
      if (poison) throw poison;
      if (outstanding) {
        // Spec D15: a second chunk before the first was confirmed is a
        // protocol violation, not a resource question. A count of one needs
        // no threshold and no byte accounting, and it bounds memory by
        // construction: maxPorts x one chunk.
        poison = new Error(
          "webrun-rpc: peer sent a second unconfirmed chunk; the stream port is closed",
        );
        finished = true;
        wake();
        void deliver?.({ done: true, error: poison });
        // Close on the next macrotask, so listenPort still gets to post the
        // refusal on this one — a virtual port goes inert the instant it
        // closes, and a silent drop would leave the offender hanging rather
        // than telling it what it did wrong.
        setTimeout(() => {
          try {
            void port.close?.();
          } catch {
            /* already gone */
          }
        }, 0);
        throw poison;
      }
      outstanding = true;
      try {
        await ready();
        if (finished) throw poison ?? new Error("webrun-rpc: the stream is closed");
        await deliver?.({
          done,
          value,
          error: error ? deserializeError(error) : undefined,
        });
      } finally {
        outstanding = false;
      }
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/duplex-over-port-hostile.test.ts`
Expected: PASS, 4 tests. Then the whole package plus `typecheck`, `typecheck:tests`, `lint`.

If the cooperative-sender test (2) went red, the enforcement is too strict: the `outstanding` flag
must be cleared in a `finally` that runs before the reply is posted, and a cooperative peer must
never see a refusal. Fix that rather than loosening the rule.

- [ ] **Step 5: Measure the mutation**

Per G10. Change `if (outstanding)` to `if (false)`. Run the hostile file.
Prediction: test 1 fails (no refusal). Restore and `diff`. Report the measured result — and, in
particular, whether test 3 also changed, since a mutation that kills two tests and one that kills
one are different facts about the suite.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-rpc/src/duplex-over-port.ts \
        packages/webrun-rpc/tests/duplex-over-port-hostile.test.ts
git commit -m "feat(rpc): a second unconfirmed chunk closes the stream port

Spec D15. A count of one needs no threshold, no byte accounting and nothing
to tune, and it bounds memory by construction (maxPorts x one chunk) rather
than by the guessed number maxStreamBuffer was. The refusal is posted before
the port closes, so the offender learns what it did.

The emulateMux hostile suite stays where it is: it tests a wire format that
still exists. These are the layer 2 answers to the same questions."
```

---

### Task 6: `transferPortMux`

A second `PortMux` whose ports come from the platform (spec D23). Per the human partner's ruling,
**cross-boundary testing is deferred**: worker, iframe and service-worker transfer are platform
behaviour we have prior evidence for, and they get exercised at application integration. This task
tests against Node's `MessageChannel` only, which is where the mechanism itself lives.

**Files:**
- Create: `packages/webrun-rpc/src/transfer-port-mux.ts`
- Modify: `packages/webrun-rpc/src/index.ts`
- Test: `packages/webrun-rpc/tests/transfer-port-mux.test.ts`

**Interfaces:**
- Consumes: `PortMux` from `./port-types.js`; `MessageTarget` from `./message-target.js`;
  `duplexOverPort` / `serveDuplexOverPort` from Task 2 (tests only).
- Produces, from `./transfer-port-mux.js` and re-exported by the package root:
  - `export interface TransferPortMuxOptions { onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined; maxMessageSize?: number }`
  - `export function transferPortMux(target: MessageTarget, options?: TransferPortMuxOptions): PortMux`
  - `export const PORT_TRANSFER = "webrun-rpc:port-transfer"` — the envelope's `type`.

  `openPort(meta?)` resolves to a real `MessagePort`. There is no `side` and no `maxPorts`: the
  platform allocates, so there is no id table to bound.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-rpc/tests/transfer-port-mux.test.ts`:

```ts
import { collectBytes } from "@statewalker/webrun-streams";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplexOverPort,
  type MessageTarget,
  PORT_TRANSFER,
  serveDuplexOverPort,
  transferPortMux,
} from "../src/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitFor(label: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const open: Array<() => void> = [];
afterEach(() => {
  for (const c of open.splice(0)) c();
});

describe("transferPortMux (spec D23)", () => {
  it("hands the peer a real MessagePort, and traffic flows both ways", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const accepted: Array<{ port: MessageTarget; meta: unknown }> = [];
    const server = transferPortMux(parent.port2, {
      onPort: (port, meta) => {
        accepted.push({ port, meta });
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });

    const local = await client.openPort({ kind: "stream" });
    await waitFor("the peer accepted a port", () => accepted.length === 1);
    expect(accepted[0]?.meta).toEqual({ kind: "stream" });
    // The point of D23: this is a genuine MessagePort, not an emulated one.
    expect(accepted[0]?.port).toBeInstanceOf(MessagePort);

    const fromPeer: unknown[] = [];
    accepted[0]?.port.addEventListener("message", (e) => fromPeer.push((e as MessageEvent).data));
    const fromLocal: unknown[] = [];
    local.addEventListener("message", (e) => fromLocal.push((e as MessageEvent).data));

    local.postMessage("client says hi");
    await waitFor("peer got the client's message", () => fromPeer.length === 1);
    expect(fromPeer[0]).toBe("client says hi");

    accepted[0]?.port.postMessage("server says hi");
    await waitFor("client got the peer's message", () => fromLocal.length === 1);
    expect(fromLocal[0]).toBe("server says hi");
  });

  it("a rejected port is closed rather than silently kept", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
        return false;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });

    const rejected = await client.openPort({ kind: "unwanted" });
    await waitFor("the peer saw the offer", () => offered === 1);

    // The floor for the rejection: a port the peer ACCEPTS still works, so
    // "nothing arrived" cannot be satisfied by the mux being broken.
    const seen: unknown[] = [];
    rejected.addEventListener("message", (e) => seen.push((e as MessageEvent).data));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    expect(offered).toBe(1);
  });

  it("with no onPort at all, an inbound port is rejected", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const server = transferPortMux(parent.port2);
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    const local = await client.openPort();
    const seen: unknown[] = [];
    local.addEventListener("message", (e) => seen.push((e as MessageEvent).data));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });

  it("ignores traffic on the parent that is not a port transfer", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    for (const junk of [undefined, null, 7, "text", { type: "something-else" }, { type: PORT_TRANSFER }]) {
      parent.port1.postMessage(junk);
    }
    // The last one has the right `type` but no transferred port, so it must
    // also be ignored rather than throwing.
    await new Promise((r) => setTimeout(r, 30));
    expect(offered).toBe(0);
    // Floor: a real transfer on the same parent still works.
    await client.openPort();
    await waitFor("a real transfer still arrives", () => offered === 1);
  });

  it("close() stops accepting and rejects further openPort calls", async () => {
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    let offered = 0;
    const server = transferPortMux(parent.port2, {
      onPort: () => {
        offered++;
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      parent.port1.close();
      parent.port2.close();
    });
    await client.openPort();
    await waitFor("first transfer arrived", () => offered === 1);

    await server.close();
    await client.openPort();
    await new Promise((r) => setTimeout(r, 30));
    expect(offered).toBe(1);

    await client.close();
    await expect(client.openPort()).rejects.toThrow(/multiplexer is closed/);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("a Duplex runs over a transferred port unchanged", async () => {
    // The seam claim in D23: layer 2 cannot tell which multiplexer produced
    // the port it was handed.
    const parent = new MessageChannel();
    parent.port1.start();
    parent.port2.start();
    const server = transferPortMux(parent.port2, {
      onPort: (port) => {
        serveDuplexOverPort(port, async function* echo(input) {
          for await (const chunk of input) yield chunk;
        });
      },
    });
    const client = transferPortMux(parent.port1);
    open.push(() => {
      void client.close();
      void server.close();
      parent.port1.close();
      parent.port2.close();
    });
    const streamPort = await client.openPort({ kind: "stream" });
    const out = await collectBytes(duplexOverPort(streamPort)([enc.encode("over a real port")]));
    expect(dec.decode(out)).toBe("over a real port");
  }, 20_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/transfer-port-mux.test.ts`
Expected: FAIL at import — `transferPortMux` and `PORT_TRANSFER` are not exported.

- [ ] **Step 3: Implement it**

Create `packages/webrun-rpc/src/transfer-port-mux.ts`:

```ts
import type { MessageTarget } from "./message-target.js";
import type { PortMux } from "./port-types.js";

/** The `type` of the envelope that carries a transferred port to the peer. */
export const PORT_TRANSFER = "webrun-rpc:port-transfer";

export interface TransferPortMuxOptions {
  /**
   * Called when the peer transfers a port in. Return `false` to reject it: the
   * port is closed and nothing further arrives on it. Any other return value —
   * including `undefined` — accepts.
   *
   * With no `onPort` at all, inbound ports are rejected, matching
   * `multiplexPort`: a port nobody holds has no consumer.
   */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined;
  /** Reported to layer 2, never enforced. A `MessagePort` normally has none. */
  maxMessageSize?: number;
}

/**
 * A `PortMux` whose ports are real, transferred `MessagePort`s (spec D23).
 *
 * `openPort` creates a `MessageChannel`, transfers one end to the peer over
 * `target`, and returns the other. There is no id table, no `maxPorts` and no
 * envelope overhead per message, because the platform does the multiplexing.
 *
 * **It needs structured clone with transferables**, so it exists in browsers,
 * workers and iframes and nowhere else that lacks them. A caller selects it
 * explicitly rather than by capability sniffing (spec D21): use
 * `multiplexPort` where the transport is one pipe of bytes.
 *
 * What it buys over emulation: a transferred port can cross an origin or a
 * worker boundary and be handed to code that never saw `target`, where an
 * emulated port id is meaningless outside its own mux.
 *
 * `target` must be a full `MessageTarget`. Reaching a send-only `MessageSink`
 * — a `ServiceWorkerClient`, say — is a real use of port transfer but needs a
 * different entry point, and is not part of this interface.
 */
export function transferPortMux(
  target: MessageTarget,
  options: TransferPortMuxOptions = {},
): PortMux {
  const { onPort, maxMessageSize } = options;
  const issued = new Set<MessagePort>();
  let closed = false;

  const listener = (event: MessageEvent): void => {
    if (closed) return;
    const data = event.data as { type?: unknown; meta?: unknown } | undefined;
    if (!data || typeof data !== "object" || data.type !== PORT_TRANSFER) return;
    const port = event.ports?.[0];
    // The right `type` with no port attached is a malformed message, not a
    // transfer. Dropping it keeps a shared parent port uncorrupted.
    if (!port) return;
    port.start();
    let accepted = false;
    if (onPort) {
      try {
        accepted = onPort(port, data.meta) !== false;
      } catch {
        accepted = false;
      }
    }
    if (!accepted) {
      port.close();
      return;
    }
    issued.add(port);
  };

  target.addEventListener("message", listener);
  void target.start?.();

  return {
    maxMessageSize,

    async openPort(meta?: unknown): Promise<MessageTarget> {
      if (closed) throw new Error("webrun-rpc: the multiplexer is closed");
      const channel = new MessageChannel();
      channel.port1.start();
      // The transferred end is not referenced from the message itself, so it
      // arrives in `event.ports` on the peer — the platform's own hand-off,
      // identical in Node and in browsers.
      target.postMessage({ type: PORT_TRANSFER, meta }, [channel.port2]);
      issued.add(channel.port1);
      return channel.port1;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      target.removeEventListener("message", listener);
      for (const port of issued) {
        try {
          port.close();
        } catch {
          /* already gone */
        }
      }
      issued.clear();
      await target.close?.();
    },
  };
}
```

Add to `packages/webrun-rpc/src/index.ts`, in the file's alphabetical position:

```ts
export * from "./transfer-port-mux.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/transfer-port-mux.test.ts`
Expected: PASS, 6 tests. Then the whole package plus `typecheck`, `typecheck:tests`, `lint`.

If `expect(accepted[0]?.port).toBeInstanceOf(MessagePort)` fails to typecheck, `MessagePort` is
available as a global value in Node ≥ 15 and as a type in the DOM lib this package already includes;
do not add a `node:worker_threads` import to make it pass — report the failure instead, because it
would mean the DOM/Node global overlap this package relies on is not what B1 established.

- [ ] **Step 5: Measure two mutations**

Per G10.

| mutation | predicted killer |
| --- | --- |
| in `listener`, delete `if (!accepted) { port.close(); return; }` and always `issued.add(port)` | the rejection test — a rejected port stays live |
| in `listener`, delete `if (!port) return;` | the "ignores traffic on the parent" test — `{ type: PORT_TRANSFER }` with no port throws inside the listener |

Record what each actually killed. If the second mutation kills nothing observable — because the
throw happens inside the raw port's own listener, outside any assertion's reach — say so; that is
the same knowingly-uncovered shape Plan A recorded for `multiplexPort`, and the honest description
is "the suite still exits non-zero", not "covered".

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-rpc/src/transfer-port-mux.ts packages/webrun-rpc/src/index.ts \
        packages/webrun-rpc/tests/transfer-port-mux.test.ts
git commit -m "feat(rpc): transferPortMux — a PortMux whose ports are real MessagePorts

Spec D23. One MessageChannel per openPort, one end transferred to the peer,
so the platform does the multiplexing: no id table, no maxPorts, no envelope
per message. It needs structured clone with transferables, so the caller
selects it explicitly rather than by sniffing (D21).

Cross-boundary transfer (worker, iframe, service worker) is platform
behaviour and is deferred to application integration by decision; these tests
cover the mechanism against Node's MessageChannel."
```

---

### Task 7: the new stack at the `Duplex` seam

The point of the whole design (spec D9): because `duplexOverPort` produces a `Duplex`, the existing
L0–L6 conformance suite covers the new stack **without changing the suite**. This adds a second run
alongside the existing `emulateMux` one, which stays (G7, G8).

**Files:**
- Create: `packages/webrun-rpc/tests/conformance-new-stack.test.ts`

**Interfaces:**
- Consumes: `describeDuplexAdapter`, `MakePair` from `@statewalker/webrun-streams-conformance`;
  `multiplexPort`, `structuredCodec`, `duplexOverPort`, `serveDuplexOverPort` from `../src/index.js`.
- Produces: nothing importable. The deliverable is a passing second conformance run.

- [ ] **Step 1: Write the pair and run the suite**

Create `packages/webrun-rpc/tests/conformance-new-stack.test.ts`:

```ts
import type { Duplex } from "@statewalker/webrun-streams";
import type { MakePair } from "@statewalker/webrun-streams-conformance";
import { describeDuplexAdapter } from "@statewalker/webrun-streams-conformance";
import {
  duplexOverPort,
  multiplexPort,
  type PortMux,
  serveDuplexOverPort,
  structuredCodec,
} from "../src/index.js";

/**
 * The B2 stack, end to end: one `MessageChannel`, `multiplexPort` on each end,
 * a virtual port per call, and `duplexOverPort` on that port.
 *
 * `PairTuning` is deliberately ignored. L6 asks for a credit window
 * (`mtu`, `maxStreamBuffer`) that this design removes — under spec D11 there
 * is no window to shrink — so for this pair **L6 is an integrity check only**:
 * its green says the body round-trips, and says nothing at all about flow
 * control. That is not an oversight. L6's redefinition and the `PairTuning`
 * reshape are spec D17, sequenced into Plan C because five adapters still run
 * L6 against `emulateMux`, where the credit window is real and the level does
 * cover it.
 *
 * This stack's flow-control coverage lives in its own files:
 * `duplex-over-port-timeout.test.ts` (the F5 regression, and that progress
 * resets the clock) and `duplex-over-port-hostile.test.ts` (a second
 * unconfirmed chunk is refused). Do not cite this L6 as evidence for either.
 */
const makeNewStackPair: MakePair = async () => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  let serverMux: PortMux | undefined;
  let clientMux: PortMux | undefined;

  return {
    async connect() {
      clientMux ??= multiplexPort(channel.port1, {
        codec: structuredCodec,
        side: "initiator",
      });
      const mux = clientMux;
      const call: Duplex = (input) =>
        (async function* () {
          const streamPort = await mux.openPort({ kind: "stream" });
          yield* duplexOverPort(streamPort, { maxMessageSize: mux.maxMessageSize })(input);
        })();
      return {
        call,
        async close() {
          /* the pair's own close tears the muxes down */
        },
      };
    },

    async serve(handler: Duplex) {
      const mux = multiplexPort(channel.port2, {
        codec: structuredCodec,
        side: "responder",
        onPort: (port) => {
          serveDuplexOverPort(port, handler, { maxMessageSize: mux.maxMessageSize });
        },
      });
      serverMux = mux;
      let torn = false;
      return async () => {
        if (torn) return;
        torn = true;
        if (serverMux === mux) serverMux = undefined;
        await mux.close();
      };
    },

    async close() {
      await clientMux?.close().catch(() => {});
      await serverMux?.close().catch(() => {});
      clientMux = undefined;
      serverMux = undefined;
      try {
        channel.port1.close();
      } catch {
        /* ignore */
      }
      try {
        channel.port2.close();
      } catch {
        /* ignore */
      }
    },
  };
};

describeDuplexAdapter("webrun-rpc (multiplexPort + duplexOverPort)", makeNewStackPair);
```

Run: `pnpm --filter @statewalker/webrun-rpc test -- tests/conformance-new-stack.test.ts`
Expected: 11 tests, all passing (L0's four bodies, L1, L2, L3, L4, L5's two, L6).

- [ ] **Step 2: Diagnose whatever failed, and fix it in the source, not the pair**

This is the task's real work. Every level is a claim about `duplexOverPort`, and a pair rigged to
make a level pass is worse than a red one.

Two failures are foreseeable and their fixes are named:

*L0's 10 MiB body times out.* With `maxMessageSize` unset, that body is one structured-clone hop —
it should be fast. If it is slow, the cause is per-chunk overhead somewhere, not the body size.
Do **not** reach for `opts.skipHugeBody` — that hides R3's exact failure mode, where a body arrived
as zero bytes with no error.

*L1's 10 concurrent calls interleave or hang.* Each call opens its own port, so the streams share no
state; if they interfere, the leak is in `duplexOverPort` binding something per port that is
actually per module. Find it and fix it there.

If a level fails for a reason neither paragraph covers, that is the most valuable finding in this
plan — describe it fully in your report before fixing it.

- [ ] **Step 3: Confirm the old run still passes**

Run: `pnpm --filter @statewalker/webrun-rpc test`
Expected: **both** conformance runs green — `webrun-rpc (MessageChannel pair)` and
`webrun-rpc (multiplexPort + duplexOverPort)`, 11 tests each. Report both names and both counts;
this is the evidence that G7 held and nothing was migrated out from under the old stack.

Then `pnpm --filter @statewalker/webrun-rpc typecheck`, `typecheck:tests`, `lint`.

- [ ] **Step 4: Run the whole repository**

Run: `pnpm -r test` and `pnpm -r typecheck` from the assembly root
(`worktrees/dev/`, **not** the umbrella root — the umbrella globs `workspaces/*`, which does not
exist there, so commands from it are silent no-ops).
Expected: everything green. Report the repo-wide totals as a delta against the baseline you
recorded at Task 1, and state the two numbers rather than reconciling to any figure in this plan.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-rpc/tests/conformance-new-stack.test.ts \
        packages/webrun-rpc/src/duplex-over-port.ts
git commit -m "test(rpc): run the conformance suite against the new stack too

multiplexPort + duplexOverPort passes L0-L6 with the suite unchanged, which
is spec D9's claim: because layer 2 produces a Duplex, the migration's
regression net already covers it and no adapter has to move first.

L6 is an integrity check for this pair and says nothing about flow control —
stated where the pair is declared, because a level that reads as coverage it
does not provide is worse than a missing one. Its redefinition is spec D17,
in Plan C."
```

---

### Task 8: documentation and the changeset

The package's README currently describes a byte-stream tier built on `emulateMux`. After this plan
it has two, and one of them is the future. Plan B1's findings record that a README API table stated
something false because a plan mandated the wording verbatim; the wording below is therefore
described, not dictated — write what the code does.

**Files:**
- Modify: `packages/webrun-rpc/README.md`
- Create: `.changeset/duplex-over-port.md`
- Create: `docs/superpowers/2026-09-06-port-mux-layer-2b-findings.md`

**Interfaces:**
- Consumes: the finished API from Tasks 1–7.
- Produces: no code.

- [ ] **Step 1: Update the README**

Read `packages/webrun-rpc/README.md` first, then make these changes:

1. **"What this is"** currently lists three pieces. It becomes four: port multiplexing
   (`multiplexPort` **and** `transferPortMux`), the **stream tier** (`duplexOverPort` /
   `serveDuplexOverPort`), the legacy byte-stream tier (`connect` / `serve` over `emulateMux`), and
   the typed-JSON RPC tier. Say plainly that the legacy tier is the one Plan C removes, and that
   new code should use the stream tier.
2. **A new "Streams over a port" section** with a runnable example: a `MessageChannel`, a
   `multiplexPort` on each end, `serveDuplexOverPort` in `onPort`, one `openPort` and one
   `duplexOverPort` call, printing the echoed body. Verify it by extracting the code **from the
   committed README** into a scratch `.mjs` file and running it — not from the file you generated
   it from. Plan A shipped a README check that ran a padded copy with a sleep the README never had,
   and printed OK for a program that was not the published one.
3. **A new "Transferring ports" section** for `transferPortMux`: what it does, that it needs
   structured clone with transferables so it is browsers/workers/iframes only, that the caller picks
   it explicitly, and what it buys — a port that can cross a boundary and be handed to code that
   never saw the parent.
4. **A flow-control paragraph** stating the window-of-one rule and the memory bound
   (`maxPorts × one chunk`), and that a second unconfirmed chunk closes the offending port. State
   the cost honestly, from spec D13: single-stream throughput is `chunk ÷ RTT` — negligible
   in-process, ~43 s for 10 MiB over a 50 ms round trip — and concurrency comes from running many
   streams.
5. **The timeout**: no timeout by default; the option is an inactivity timeout for the whole stream.

Check every claim you write against the code. In particular, do not write that `openPort` throws:
it rejects.

- [ ] **Step 2: Verify the README example actually runs**

```bash
mkdir -p /tmp/rpc-readme && cd packages/webrun-rpc && pnpm build && cd -
# Extract the example from the COMMITTED README, not from a draft.
git show HEAD:packages/webrun-rpc/README.md > /tmp/rpc-readme/README.md
```

Then hand-extract the fenced example from `/tmp/rpc-readme/README.md` into
`/tmp/rpc-readme/example.mjs`, point its import at the built `dist`, and run it with `node`.
Expected: it prints the echoed body and exits 0. An example that exits 0 printing nothing is a
failure — Plan A shipped exactly that.

- [ ] **Step 3: Write the changeset**

Create `.changeset/duplex-over-port.md`:

```markdown
---
"@statewalker/webrun-rpc": minor
---

Adds the stream tier and a second port multiplexer.

`duplexOverPort(port, options)` runs one `Duplex` over one port, and
`serveDuplexOverPort(port, handler, options)` is its serving half. Each
direction is one `callPort` per chunk on its own channel; the reply is the
confirmation and it is withheld until the consumer has pulled past the value,
so a producer can never run more than one chunk ahead. Memory is bounded by
construction rather than by a configured ceiling: at most one chunk per open
port. A peer that sends a second unconfirmed chunk has its call refused and
that port closed, leaving every other port untouched.

The stream carries the timeout, and it defaults to **none**. `callPort` gains
`NO_TIMEOUT` for the same reason: a per-chunk deadline fails a slow consumer,
which is a bug, not a policy. The regression test is a consumer 1200 ms per
chunk completing a transfer.

`transferPortMux(target, options)` is a second `PortMux` whose ports are real
transferred `MessagePort`s — one `MessageChannel` per `openPort`, one end
handed to the peer. It needs structured clone with transferables, so it works
in browsers, workers and iframes and not over byte transports; the caller picks
it explicitly. Unlike an emulated port, a transferred one can cross a boundary
and be used by code that never saw the parent port.

Nothing is removed. `emulateMux`, `connect`/`serve` and the existing
conformance run are unchanged, and the new stack is proven by a **second**
conformance run over the same unmodified L0–L6 suite.
```

Then verify the release configuration is not broken — Plan B1's whole-branch review found a
changeset naming a package that no longer existed, which made `npx changeset status` fail hard so
the repo could not cut a release, and no task's diff contained that file:

```bash
npx changeset status
```

Expected: exit 0. If it fails, the cause is in `.changeset/`, not in your diff — fix it and say so.

- [ ] **Step 4: Write the findings document**

Create `docs/superpowers/2026-09-06-port-mux-layer-2b-findings.md`, in the shape of its two
predecessors (read them first). It must contain, written while the evidence is to hand:

- the commit range, the end-state test counts per package, and the repo-wide total;
- **the measured mutation table** — every mutation this plan asked for, with what it *actually*
  killed beside what the plan *predicted*, and every discrepancy named as a discrepancy;
- any surviving mutation, described honestly (Plan A's standard: "unreachable under any transport
  this package ships or tests", not "dead code");
- every place this plan was wrong, with what corrected it;
- a "For whoever writes Plan C" section listing, at minimum: that `emulateMux`'s deletion also
  deletes `connect`/`serve`, `byteChannelFromMessagePort`, `ByteChannel`, `uint32.ts` and
  `tests/uint32.test.ts`, and the 11 tests of the **old** conformance run (the new run replaces
  them); that L6's redefinition and the `PairTuning` reshape are still owed (spec D17); that D14's
  shared control port is still owed; and that `-peerjs`'s message ceiling is still unmeasured.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-rpc/README.md .changeset/duplex-over-port.md \
        docs/superpowers/2026-09-06-port-mux-layer-2b-findings.md
git commit -m "docs(rpc): document the stream tier and transferPortMux

Includes the honest cost from spec D13 — single-stream throughput is
chunk/RTT — and states that the legacy connect/serve tier is what Plan C
removes, so new code does not build on it."
```

---

## Self-review

**Spec coverage.** Walking the spec's layer 2 section and the decisions this plan is scoped to:

| requirement | task |
| --- | --- |
| D8 — timeout per stream, default none; F5 fixed | 1, 4 |
| D9 — `Duplex` is layer 2's output; conformance applies unchanged | 2, 7 |
| D10 — chunk to `maxMessageSize` with `toChunks` | 2 |
| D11 — window of one, sequential within a stream | 2 (mechanism), 5 (enforcement) |
| D12 — the confirmation is `callPort` on the stream's own port | 2 |
| D15 — receiver refuses a second unconfirmed chunk; penalty scoped to the port | 5 |
| D16 — msgpack-expressible payloads only on stream ports | 2 (`WireChunk` is `{boolean, Uint8Array, plain object}`) |
| D23 — `transferPortMux` | 6 |
| Verification — "layer 2's regression test for F5" | 4 |
| Verification — hostile suite's questions answered at layer 2 | 5 |
| Verification — browser suites stay green | out of scope; nothing this plan touches is imported by an adapter (G7) |

**Deliberately not covered, each with its reason recorded in the spec:** D14's shared control port
and D17's L6 redefinition are sequenced into Plan C; D13's windowing stays future work; the
`webrun-http-browser` refactor waits until these capabilities exist.

**Known gap, stated rather than hidden:** the spec's Plan B ends with "`-port` and `-ws` on the new
stack passing L0–L6". This plan delivers `-port` (Task 7) and **not** `-ws`, because `-ws` requires
the adapter to expose a port factory, which is Plan C's layer 3 work. Nothing here blocks it; Plan C
gains one item.

**Type consistency.** `DuplexOverPortOptions` carries `maxMessageSize`, `timeout` and `log`
throughout — Task 2 defines all three, Task 4 makes `timeout` load-bearing, and no task adds a
fourth. `duplexOverPort` / `serveDuplexOverPort` / `STREAM_ABORT` / `transferPortMux` /
`PORT_TRANSFER` / `NO_TIMEOUT` are spelled identically in every task that names them. `WireChunk` is
defined once, in Task 2, and referred to by name afterwards. `receiveChunks` and `sendChunks` each
gain exactly one parameter, in Task 4, and both signatures are written out where they change.
