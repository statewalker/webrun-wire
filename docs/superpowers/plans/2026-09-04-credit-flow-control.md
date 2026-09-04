# Credit-Based Flow Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `emulateMux`'s stop-and-wait flow control with receiver-advertised credit, built on a reusable core in `webrun-streams` that is exported for the RPC tier to consume in Plan 2; and move `MessageTarget` down into `webrun-streams`.

**Architecture:** A pure credit ledger (sender side) and grantor (receiver side) live in `webrun-streams/src/flow-control.ts` with no I/O and **no unit**: they count opaque numbers. `emulateMux` wires them to the frame format — `OPEN` and `ACK` each gain a uint32 payload carrying credit, denominated in bytes. The sender reserves credit before it puts anything on the wire and stalls at zero; the receiver grants more as its consumer drains. `maxStreamBuffer` stops bounding honest peers and reverts to being a defence against peers that ignore the protocol. The core is unit-agnostic on purpose — Plan 2's RPC tier will count values rather than bytes — but this plan builds and proves it against **one** consumer, `emulateMux`.

**Tech Stack:** TypeScript, vitest, rolldown, biome. Node + browser, ESM only.

**Spec:** `docs/superpowers/specs/2026-09-04-webrun-rpc-design.md`. This plan implements **Decision 8's `emulateMux` half** — the shared core, built and proven against `emulateMux`, and exported — plus Decision 7 and Sequencing steps 1–2. Decision 8's other consumer, the RPC tier, is credited in Plan 2 when that tier moves to `webrun-rpc`. What this plan deliberately leaves to Sequencing step 3 is listed under "What this plan does not do".

## Global Constraints

- **`webrun-streams` has zero runtime dependencies.** It must still have zero when this lands. No new imports from other packages.
- **Red/green TDD, observed.** Every behavioural step writes a failing test first and *runs it to watch it fail*. A test that has never been red proves nothing. Four things in this plan genuinely cannot have one — the sub-threshold regression test in Task 3 Step 1, the whole of Task 4, the type-only move in Task 6 (whose red phase is a typecheck, not a test run), and the configuration in Task 7. Each is labelled a regression, characterization or configuration step **where it appears**, with the reason. If you find yourself writing "Expected: FAIL" for a step you cannot make fail, label it instead of inventing one.
- **The existing conformance suite stays green at every commit.** Task 3 changes the wire format four adapters embed, so it runs `-ws` and `-port` conformance before its commit rather than only `webrun-streams`' own tests — which exercise in-process pipes and cannot see a delivery-ordering regression. Task 5 runs all seven adapter suites.
- ESM only (`"type": "module"`), TypeScript strict, `moduleResolution: "Bundler"`.
- biome formatting: 2-space indent, line width 100, double quotes, semicolons always, trailing commas all. Use the **package-scoped** lint before each commit (`pnpm --filter <pkg> lint`); the root `pnpm lint` exits 1 on a pre-existing baseline — see Task 8 Step 4.
- Tests: vitest, files under `tests/`, named `*.test.ts`, run with `pnpm --filter @statewalker/webrun-streams test`.
- Frame format is `[varint streamId][1-byte type][payload]`. `sendFrame(id, type, payload?)` already supports payloads; do not change the header.
- **Wire-format change is expected and permitted.** Old and new peers will not interoperate. Spec Finding 3 establishes there are no external consumers.

## Design note: how credit bootstraps

A stream is bidirectional, so *each* side must advertise the capacity of *its own* receive buffer to the peer.

- Both ledgers start at **zero**. Neither side may send a byte it was not granted — no exceptions, no bootstrap allowance.
- The caller's `OPEN` payload carries the caller's `maxStreamBuffer`. That is the credit the responder may spend sending back, and it arrives with the frame that creates the stream, so **the responder pays no round trip**: it can answer immediately.
- On receiving `OPEN`, the responder replies `ACK` carrying *its* `maxStreamBuffer` — the credit the caller may spend.

**The caller therefore pays exactly one round trip per stream before its first DATA frame.** Say that plainly: it is the price of the guarantee that a sender can never overrun a receiver, and it is paid once per stream rather than once per frame — which is the whole point. A 10 MiB body over a 64 KiB MTU costs one round trip instead of 160.

Starting at zero also removes a whole class of arithmetic bug by construction: because `available` begins at `0`, "apply the peer's advertisement" and "apply a grant" are *the same operation* — `grant(n)`. There is no first-ACK special case, no subtraction, and no way for the two paths to disagree. An earlier draft of this plan started both ledgers at an `INITIAL_CREDIT` constant and had the two paths disagree by exactly that constant; five independent reviews found it, and two reproduced a conformant sender being torn down by the receiver's own overflow guard. Do not reintroduce it.

Because grants are never negative and the peer's advertisement is a uint32, `grant()` is only ever called with a non-negative number. There is deliberately no sign convention to test.

## Repository, package and documentation rules

These apply to every task, and to the plans that follow this one.

**Documentation moves with the code.** A package's README documents its export
surface; several of them enumerate it in tables. Any task that adds, removes,
moves or renames a public export updates the affected README **in the same
commit**, never as a follow-up. Stale export tables are worse than absent ones,
because they read as authoritative. The READMEs this plan touches are called
out in the tasks that touch them.

**This plan creates no package and renames no repository**, so `repos.json` and
the umbrella need no change here. The rules below exist because the plans that
follow — `webrun-rpc` (a new package) and the `webrun-transform` → `webrun-forge`
rename — do trigger them, and getting them wrong is expensive to unwind.

**Renaming a repository uses the `gh` CLI.** Do not rename through the web UI,
and do not create-and-push a new repository: `gh repo rename` preserves issues,
pull requests, stars and — critically — GitHub's redirect from the old URL, so
existing clones and any unmigrated `repos.json` keep working.

```bash
gh repo rename <new-name> --repo statewalker/<old-name>
```

`gh` 2.45.0 is available in this environment. After the rename, update in the
same change:

- `repos.json` in the umbrella — the registry of clone URLs.
- `docs/multirepo/MODEL.md` — names every repository and its status.
- The renamed repo's own root `package.json` `name` field (the `-monorepo`
  suffix) and its `repository.url`.
- Any cross-repo README links pointing at the old GitHub URL.

Note that **published npm package names do not contain the repository name**
(`@statewalker/webrun-modules` lives in `webrun-transform`), so a repo rename is
not an npm-visible change and needs no changeset.

**Creating a package** requires, in the same change: the package directory
under `packages/` (already covered by the workspace glob `packages/*`, so
`pnpm-workspace.yaml` needs no edit), a README following the house structure
(what it is, why it exists, install, getting started, API, dependencies,
licence), a `tsconfig.json` extending `../../tsconfig.base.json`, a
`rolldown.config.js` using `externalsFrom(import.meta.url)`, an entry in
`tsconfig.base.json`'s `paths` map, a row in the root `README.md` package
tables, and a changeset.

**The assembly under `worktrees/` is generated and gitignored.** Nothing there
is committed to the umbrella; only `repos.json` and the durable documents are.

## What this plan does not do

Scope boundaries, stated so an executor does not discover them mid-task.

**Only four adapters construct `emulateMux`.** They are `-ws`
(`src/connect.ts:35`, `src/serve.ts:26`), `-port` (`src/connect-serve.ts:15,26`),
`-peerjs` (`src/connect-serve.ts:17,32`) and `-livekit`
(`src/connect-serve.ts:14,25`). `-webrtc` uses `duplexOverDataChannel` and
`-libp2p` uses native yamux multiplexing; neither imports `emulateMux`, has an
`mtu` or a `maxStreamBuffer`, or is affected by the wire-format change. Task 5
widens **four** public parameter types, not six. For `-webrtc` and `-libp2p` the
new L6 level proves the `Duplex` seam still holds, not the credit path — a
failure there is an L6-authoring bug, not a credit regression.

**The RPC tier is not migrated here.** `webrun-streams-port`'s `send`/`recieve`
still awaits a `callPort` round trip per value, and this plan leaves it that way.
An earlier draft of this plan migrated it in a task of its own; that task was
**deleted** (ledger decision D9), and the reasons are recorded here so the
decision is not silently revisited:

- **It removes no round trip.** A message census of the same stream counted
  **41 requests and 41 responses on both the old and the new implementation**:
  `listenPort` replies to every chunk unconditionally, so pipelining changes
  what blocks, not what is sent.
- **It introduces a real truncation regression.** `callPort`'s `timeout`
  defaults to 1000 ms *per value*. Firing up to `maxInFlightValues` (16) calls
  concurrently converts that into a deadline for the whole window, because a
  reply is withheld until the consumer pulls past its value. Measured over 40
  values at a consumer rate of `d` ms/value: the new `send` delivered 40/40 at
  `d = 20` and `d = 40`, **34/40 at `d = 60` and 26/40 at `d = 80`**, each
  truncating with `Error: Call timeout`; the committed code delivered 40/40 at
  every rate. The draft's own tests ran at `d = 2`, thirty times below the
  cliff, and were green throughout.
- **It would migrate the same code twice.** Spec Sequencing step 3 moves
  `send`/`recieve` into a new `webrun-rpc` package and renames them
  `sendValues`/`receiveValues` (Decision 9). Crediting the tier once, against
  its final shape, is strictly cheaper than crediting it here and again there.

So the RPC tier moves to `webrun-rpc` in **Plan 2** and is put on this core
there, with the timeout question resolved as part of that work. The core is
still **exported** from `webrun-streams` by Task 1 Step 6 — Plan 2 consumes it
from another package and cannot reach a module the barrel does not export — and
it is still unit-agnostic, because the second consumer counts values. What this
plan does not claim is that the core has been *proven* against two consumers: it
has one, and Plan 2 is where the second one tests the shape.

In-order reassembly likewise stays the tier's concern — the core has no notion
of ordering beyond releasing its own waiters FIFO.

**A one-frame credit window is reachable but is not what conformance runs.**
Spec Verification asks for conformance "at a small advertised credit (one
frame's worth, reproducing today's lock-step behaviour) and at the default".
L6 runs at a small window (16 KiB against a 256 KiB body — sixteen stalls), and
`webrun-streams`' own tests cover the exact-one-frame case. Conformance does not
run the whole L0–L5 set twice; that would double every adapter's suite for a
property the unit tests pin more precisely.

**Conformance cannot express asymmetrically configured peers.** Both spec
sections ask for asymmetric peers to be asserted in conformance, but `PairTuning`
is a single `{ mtu?, maxStreamBuffer? }` object and every pair factory spreads
the *same* object into both ends, so L6 structurally cannot set a different
window on each side. This plan asserts the asymmetric case in `webrun-streams`'
own tests only (`a large-buffer sender and a small-buffer receiver…`).
Conformance-level asymmetry needs `PairTuning` reshaped to
`{ initiator?, responder? }` and is deferred to Plan 2.

**Three browser-gated adapters still have no executable conformance run.** Task
7 verifies the `vitest.browser.config.ts` files their `test:browser` scripts name
— those files did not exist, so the scripts failed to load at all — but
`-webrtc`, `-peerjs` and `-livekit` also reference `tests/make-webrtc-pair.ts`,
`tests/make-peerjs-pair.ts` and `tests/make-livekit-pair.ts`, and **none of those
files exists in the repository**. Writing them is a separate piece of work and is
not in this plan. Task 7 says so in the commit message rather than implying the
suites now run.

## File Structure

**Create**
- `packages/webrun-streams/src/flow-control.ts` — pure credit ledger + grantor. No I/O, no framing, no transport types, no unit.
- `packages/webrun-streams/src/uint32.ts` — the credit payload codec. **Not** re-exported from `index.ts`.
- `packages/webrun-streams/src/message-target.ts` — the four message-passing interfaces, moved from `webrun-http-browser`.
- `packages/webrun-streams/tests/flow-control.test.ts` — unit tests for the ledger and grantor.
- `packages/webrun-streams/tests/uint32.test.ts` — unit tests for the codec.
- `packages/webrun-streams/tests/emulate-mux-credit.test.ts` — the wire-level credit tests.
- `packages/webrun-streams/tests/message-target.test.ts` — shape tests for the moved interfaces.
- `packages/webrun-streams-{webrtc,peerjs,livekit}/vitest.browser.config.ts` — already committed in `b6d4683`; Task 7 verifies rather than creates them.
- `.changeset/<generated>.md` — the release note (Task 8 Step 7).
- `packages/webrun-streams/tsconfig.tests.json` — typecheck config that widens the program to `tests/` (Task 6 needs it; the pattern is copied from `webrun-http-streams`).

**Modify**
- `packages/webrun-streams/src/emulate-mux.ts` — credit on `OPEN`/`ACK`, `pumpOutbound` reserves, inbound grants.
- `packages/webrun-streams/src/index.ts` — export `flow-control.js` and `message-target.js`.
- `packages/webrun-streams/package.json` — add `typecheck:tests`.
- `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts` — four of its five tests pin stop-and-wait and are rewritten to pin the credit bound.
- `packages/webrun-streams/tests/emulate-mux.test.ts` — one frame-level test hand-rolls a peer that must now speak credit.
- `packages/webrun-streams/tests/emulate-mux-hostile.test.ts` — stale explanation, plus an assertion on what the hostile peer was actually granted.
- `packages/webrun-http-browser/src/core/message-target.ts` — becomes a re-export from `webrun-streams` (5 files import it; re-exporting avoids touching them all).
- `packages/webrun-streams-conformance/src/{loopback,describe-duplex-adapter,index}.ts` — `MakePair` takes optional tuning; an L6 level covers flow control.
- `packages/webrun-streams-port/src/connect-serve.ts` — `PortParams` gains `mux`.
- `packages/webrun-streams-{ws,peerjs,livekit}/src/*` — params gain `mux`.
- `packages/webrun-streams-{ws,port}/tests/*` — pair factories forward the tuning.
- `packages/webrun-streams-conformance/tests/emulate-mux.test.ts` — loopback pair factory signature.
- `packages/webrun-streams-{webrtc,peerjs,livekit}/package.json` — browser test devDeps (already committed in `b6d4683`).
- `.changeset/config.json`, `PUBLISHING.md` — release safety (already committed; Task 7 verifies).
- READMEs: `webrun-streams`, `webrun-streams-conformance`, `webrun-streams-port`, `webrun-streams-ws`, `webrun-streams-peerjs`, `webrun-streams-livekit`, `webrun-http-browser`, and the root `README.md`.
- `docs/adr/0004-duplex-as-seam.md` — one annotation; the conformance suite it describes gains a level (Task 5 Step 8).

---

### Task 1: Credit ledger and grantor (pure, no I/O, no unit)

**Files:**
- Create: `packages/webrun-streams/src/flow-control.ts`
- Test: `packages/webrun-streams/tests/flow-control.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `newCreditLedger(initial?: number): CreditLedger` where
    `CreditLedger = { readonly available: number; reserve(upTo: number): Promise<number>; grant(units: number): void; fail(err: Error): void }`
  - `newCreditGrantor(window: number, threshold?: number): CreditGrantor` where
    `CreditGrantor = { consumed(units: number, queueEmpty: boolean): number }`

Two shapes here are load-bearing and are not stylistic:

- **`reserve(upTo)` returns how much it got**, rather than `spend(exact)`
  resolving when the exact amount is available. A sender asks for one MTU and
  takes whatever the window can cover. Without this, a sender whose `mtu`
  exceeds the peer's whole advertised window parks on a reservation that can
  *never* be satisfied — the receiver grants only what its consumer drains, and
  it can drain nothing because nothing was sent. That is a silent permanent
  hang with no error and no timeout, strictly worse than the teardown credit
  exists to remove.
- **`consumed` takes `queueEmpty`.** The grantor cannot see the receive queue,
  so the caller passes it. See Step 3's comment for what it buys.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-streams/tests/flow-control.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newCreditGrantor, newCreditLedger } from "../src/flow-control.js";

describe("newCreditLedger", () => {
  it("starts at zero and blocks the first reservation until a grant arrives", async () => {
    const ledger = newCreditLedger();
    expect(ledger.available).toBe(0);
    let granted = -1;
    const pending = ledger.reserve(40).then((n) => {
      granted = n;
    });
    await Promise.resolve();
    expect(granted).toBe(-1);

    ledger.grant(100);
    await pending;
    expect(granted).toBe(40);
    expect(ledger.available).toBe(60);
  });

  it("grants a partial reservation rather than waiting for the full amount", async () => {
    const ledger = newCreditLedger();
    ledger.grant(30);
    expect(await ledger.reserve(80)).toBe(30);
    expect(ledger.available).toBe(0);
  });

  it("releases a waiter partially, so an over-window request still progresses", async () => {
    const ledger = newCreditLedger();
    const first = ledger.reserve(64 * 1024);
    ledger.grant(4096);
    expect(await first).toBe(4096);
    const second = ledger.reserve(64 * 1024 - 4096);
    ledger.grant(4096);
    expect(await second).toBe(4096);
  });

  it("releases waiters strictly in order", async () => {
    const ledger = newCreditLedger();
    const order: number[] = [];
    const first = ledger.reserve(10).then((n) => order.push(1 * n));
    const second = ledger.reserve(10).then((n) => order.push(2 * n));

    ledger.grant(10);
    await first;
    expect(order).toEqual([10]);

    ledger.grant(10);
    await second;
    expect(order).toEqual([10, 20]);
  });

  it("does not let a later reservation overtake a queued one", async () => {
    const ledger = newCreditLedger();
    const head = ledger.reserve(100);
    let tailDone = false;
    void ledger.reserve(1).then(() => {
      tailDone = true;
    });
    ledger.grant(1);
    expect(await head).toBe(1);
    expect(tailDone).toBe(false);
  });

  it("rejects a reservation of less than one unit", async () => {
    const ledger = newCreditLedger();
    ledger.grant(100);
    await expect(ledger.reserve(0)).rejects.toThrow(RangeError);
    // Nothing was consumed: not credit, and not a waiter slot.
    expect(ledger.available).toBe(100);
  });

  it("rejects pending reservations when failed", async () => {
    const ledger = newCreditLedger();
    const pending = ledger.reserve(10);
    ledger.fail(new Error("transport closed"));
    await expect(pending).rejects.toThrow("transport closed");
  });

  it("rejects later reservations once failed", async () => {
    const ledger = newCreditLedger();
    ledger.grant(1000);
    ledger.fail(new Error("gone"));
    await expect(ledger.reserve(1)).rejects.toThrow("gone");
  });
});

describe("newCreditGrantor", () => {
  it("accumulates silently below the threshold while the queue is non-empty", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20, false)).toBe(0);
    expect(grantor.consumed(20, false)).toBe(0);
  });

  it("emits the accumulated total once the threshold is reached, then resets", () => {
    const grantor = newCreditGrantor(100);
    expect(grantor.consumed(20, false)).toBe(0);
    expect(grantor.consumed(30, false)).toBe(50);
    expect(grantor.consumed(10, false)).toBe(0);
  });

  it("flushes a sub-threshold batch as soon as the queue empties", () => {
    const grantor = newCreditGrantor(1024);
    expect(grantor.consumed(300, false)).toBe(0);
    expect(grantor.consumed(0, true)).toBe(300);
  });

  it("stays silent on an empty queue when nothing is pending", () => {
    const grantor = newCreditGrantor(1024);
    expect(grantor.consumed(0, true)).toBe(0);
  });

  it("honours a custom threshold fraction", () => {
    const grantor = newCreditGrantor(100, 0.25);
    expect(grantor.consumed(25, false)).toBe(25);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: **exit 1, a startup error, and no tests at all** — not a failed
assertion. vitest 4.1.11 prints:

```
 FAIL  tests/flow-control.test.ts [ tests/flow-control.test.ts ]
Error: Cannot find module '../src/flow-control.js' imported from <repo>/packages/webrun-streams/tests/flow-control.test.ts
```

and summarises `Test Files  1 failed (1)` / `Tests  no tests`. Take the absence
of a run as the red phase here; there is no assertion to fail yet.

- [ ] **Step 3: Write the implementation**

Create `packages/webrun-streams/src/flow-control.ts`:

```ts
/**
 * Credit-based flow control, as a pair of pure state machines with no I/O.
 *
 * The sender holds a {@link CreditLedger}: it reserves credit before it puts
 * anything on the wire, and stalls at zero. The receiver holds a
 * {@link CreditGrantor}: it counts what its consumer has actually drained and
 * says when to hand the sender more.
 *
 * A sender therefore cannot overrun a receiver's buffer, because it was never
 * granted permission to. That is the property a sender-side window cannot
 * offer: the receiver's capacity is not knowable to the sender unless the
 * receiver states it.
 *
 * **The unit is opaque.** This module never interprets the numbers it counts.
 * `emulateMux` passes byte counts and advertises `maxStreamBuffer`; the RPC
 * tier passes 1 per value and advertises a maximum in-flight value count.
 * Nothing here depends on which.
 */

export interface CreditLedger {
  /** Units authorised by the peer and not yet reserved. */
  readonly available: number;
  /**
   * Reserve up to `upTo` units, resolving with how many were actually
   * granted — at least 1, never more than `upTo`. The caller sends exactly
   * that much and calls `reserve` again for the rest.
   *
   * `upTo` must itself be at least 1; anything less rejects with a
   * `RangeError` rather than resolving with 0, which would be a silent no-op
   * that also consumed a waiter slot.
   *
   * Returning a partial amount rather than waiting for the full request is
   * what makes the ledger deadlock-free: a peer that advertises less than
   * one `upTo` still makes progress, one short piece at a time.
   *
   * Rejects if {@link fail} is called.
   */
  reserve(upTo: number): Promise<number>;
  /** The peer authorised `units` more. */
  grant(units: number): void;
  /** Reject every pending and future reservation — transport or stream is gone. */
  fail(err: Error): void;
}

interface Waiter {
  upTo: number;
  resolve: (granted: number) => void;
  reject: (err: Error) => void;
}

export function newCreditLedger(initial = 0): CreditLedger {
  let available = initial;
  let failure: Error | undefined;
  const waiters: Waiter[] = [];

  // Waiters are released strictly in order, head first. Letting a later
  // reservation overtake an earlier one would reorder the stream.
  const pump = (): void => {
    while (waiters.length > 0 && available > 0) {
      const next = waiters[0];
      if (!next) return;
      waiters.shift();
      const granted = Math.min(next.upTo, available);
      available -= granted;
      next.resolve(granted);
    }
  };

  return {
    get available() {
      return available;
    },
    reserve(upTo: number): Promise<number> {
      if (failure) return Promise.reject(failure);
      // A reservation below one unit is a caller bug, not a legal request: the
      // contract is "at least 1", and the queued path would otherwise consume
      // a waiter in order to hand back nothing.
      if (!(upTo >= 1)) {
        return Promise.reject(
          new RangeError(`newCreditLedger: reserve(${upTo}) — upTo must be at least 1`),
        );
      }
      if (waiters.length === 0 && available > 0) {
        const granted = Math.min(upTo, available);
        available -= granted;
        return Promise.resolve(granted);
      }
      return new Promise<number>((resolve, reject) => {
        waiters.push({ upTo, resolve, reject });
      });
    },
    grant(units: number): void {
      if (failure) return;
      available += units;
      pump();
    },
    fail(err: Error): void {
      failure ??= err;
      while (waiters.length > 0) {
        waiters.shift()?.reject(err);
      }
    },
  };
}

export interface CreditGrantor {
  /**
   * Record that the consumer drained `units`, and whether the receive queue
   * is now empty. Returns the credit to hand back to the peer, or `0` to stay
   * silent and keep accumulating.
   */
  consumed(units: number, queueEmpty: boolean): number;
}

/**
 * Grants are batched: replenishing on every chunk while the receiver is
 * behind would reinvent the per-frame ACK this change exists to remove.
 * `threshold` is the fraction of the window that must drain before a grant is
 * emitted.
 *
 * The batch is flushed unconditionally once the receive queue is empty, even
 * below the threshold, so the receiver never sits on credit it owes. Note what
 * this is and is not: paired with a {@link CreditLedger}, a sender blocks only
 * at *exactly* zero credit, and at that point the receiver holds the entire
 * window as `pending` — above any threshold at or below the whole window — so
 * the threshold alone cannot deadlock that pairing. The flush is what keeps
 * that from being an argument about a global accounting identity: it is
 * locally decidable from one boolean, and it returns owed credit now rather
 * than at the next threshold crossing. It costs an extra frame only when the
 * consumer is keeping pace, which is exactly when the sender is not blocked
 * and the frame is cheap.
 */
export function newCreditGrantor(window: number, threshold = 0.5): CreditGrantor {
  const trigger = Math.max(1, Math.floor(window * threshold));
  let pending = 0;
  return {
    consumed(units: number, queueEmpty: boolean): number {
      pending += units;
      if (pending === 0) return 0;
      if (pending < trigger && !queueEmpty) return 0;
      const grant = pending;
      pending = 0;
      return grant;
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/flow-control.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Prove the tests are not vacuous**

Five one-line mutations, applied one at a time and reverted:

| mutation | must turn red |
| --- | --- |
| in `pump`, `const granted = next.upTo;` (ignore `available`) | `releases a waiter partially…`, `does not let a later reservation overtake…` |
| in `pump`, `while (waiters.length > 0) {` (drop the `available > 0` guard) | `releases waiters strictly in order`, `does not let a later reservation overtake…` |
| in `pump`, `waiters.pop()` instead of `waiters.shift()` | `releases waiters strictly in order` |
| in `consumed`, `if (pending < trigger) return 0;` (drop the flush) | `flushes a sub-threshold batch as soon as the queue empties` |
| in `reserve`, delete the `if (!(upTo >= 1))` guard | `rejects a reservation of less than one unit` |

If any mutation leaves all 13 green, the test that was supposed to catch it is
not doing its job — fix the test, not the table. Revert every mutation before
Step 6.

Measured for the last row (the other four were re-run and match as written):

```
=== drop the upTo >= 1 guard ===
 FAIL  tests/flow-control.test.ts > newCreditLedger > rejects a reservation of less than one unit
AssertionError: promise resolved "+0" instead of rejecting
      Tests  1 failed | 12 passed (13)
```

- [ ] **Step 6: Export from the package index**

In `packages/webrun-streams/src/index.ts`, add the export in alphabetical position (after `./errors.js`):

```ts
export * from "./flow-control.js";
```

This is a published compatibility commitment, and it is made **before** the
core has a second consumer. That is deliberate: Plan 2 puts `webrun-rpc` on this
core from a *different package*, and a module the barrel does not export is
unreachable from there. The cost is that the surface is frozen having been
proven against one consumer only — `emulateMux`. The shape was chosen with the
second in mind (see the "no unit" note above and `reserve(upTo)`'s doc comment),
but "designed for" is not "proven against", and Plan 2 is where the second
consumer gets to test it. If Plan 2 finds the shape wrong, that is a `0.x`
minor bump on `webrun-streams`, not a silent break — see Task 7 Step 3.

- [ ] **Step 7: Run the full package suite and lint**

```bash
pnpm --filter @statewalker/webrun-streams test
pnpm --filter @statewalker/webrun-streams lint
```

Expected: 144 tests passing (131 before this plan, plus the 13 above); lint exits 0. Nothing consumes the new module yet, so `emulateMux` is unaffected.

Note `webrun-streams`' `lint` script is `biome check --write .`, so it rewrites
formatting in place. It reports one pre-existing warning — `lint/style/noNonNullAssertion` inside
`decodeVarint` in `src/emulate-mux.ts` — and still exits 0. That statement is
not touched by this plan, but its **line number moves**: it is at `:522` here
(Task 1 precedes Task 3) and at `:552` from Task 3 onwards, which adds 30 lines
above it. Match on the rule and the function, not the line. A *second*
diagnostic in that file is yours.

- [ ] **Step 8: Document the new exports**

`packages/webrun-streams/README.md` has an `## Exports` section (line 276) with
grouped tables. Add a new group after the "Seam types" table. Title it
**`### Credit`**, not "Flow control": there is already a `### Flow control`
subsection at line 254 under `## \`emulateMux\``, and two headings with the same
name make every later instruction that names one of them ambiguous.

```markdown
### Credit

| Export | Kind | Purpose |
| --- | --- | --- |
| `newCreditLedger(initial?)` | function | Sender-side credit: `reserve(upTo)` waits for any credit and returns how much it got (`upTo` must be >= 1; less rejects with a `RangeError`), `grant(units)` releases waiters in order, `fail(err)` unwinds them. Starts at zero unless told otherwise. |
| `CreditLedger` | type | `{ available, reserve, grant, fail }`. |
| `newCreditGrantor(window, threshold?)` | function | Receiver-side: `consumed(units, queueEmpty)` returns the credit to hand back, batched at `threshold` (default half the window) and flushed once the queue empties. |
| `CreditGrantor` | type | `{ consumed(units, queueEmpty): number }`. |

The unit is whatever the caller counts. `emulateMux` counts bytes; a value-
oriented caller would count values. Nothing in this module interprets it.
```

- [ ] **Step 9: Commit**

```bash
git add packages/webrun-streams/src/flow-control.ts \
        packages/webrun-streams/tests/flow-control.test.ts \
        packages/webrun-streams/src/index.ts \
        packages/webrun-streams/README.md
git commit -m "feat(streams): credit ledger and grantor for flow control

Pure state machines, no I/O, no unit: the sender reserves credit before it
sends and stalls at zero, the receiver counts what its consumer drained and
says when to grant more. reserve() returns a partial amount rather than
waiting for the full request, so a sender whose frame is larger than the
peer's whole window still makes progress instead of parking forever.

Not wired into anything yet."
```

---

### Task 2: uint32 payload codec for credit frames

**Files:**
- Create: `packages/webrun-streams/src/uint32.ts`
- Test: `packages/webrun-streams/tests/uint32.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_UINT32`, `encodeUint32(n: number): Uint8Array` and `decodeUint32(bytes: Uint8Array): number | undefined`, in their own module. `decodeUint32` returns `undefined` for a payload shorter than 4 bytes, so a truncated or legacy empty frame is detectable rather than being read as garbage. `encodeUint32` **clamps** into `[0, MAX_UINT32]` rather than wrapping — see Step 3.

**Why its own module rather than a `__testing` export on `emulate-mux.ts`.**
`src/index.ts` is `export * from "./emulate-mux.js"`, so anything exported from
that file is public API: it lands in the published `dist/index.d.ts` and, since
`webrun-http-browser/src/core/index.ts` re-exports the whole of
`@statewalker/webrun-streams`, it is re-exported from that package too. A symbol
called `__testing` would be a compatibility commitment described in the plan as
"not part of the public API" — false, and a claim Task 8's README auditor would
have to be taught to ignore. A separate module the barrel does not re-export is
genuinely private, and the test imports it by path.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-streams/tests/uint32.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeUint32, encodeUint32 } from "../src/uint32.js";

describe("uint32 credit payloads", () => {
  it("round-trips a value", () => {
    const bytes = encodeUint32(8 * 1024 * 1024);
    expect(bytes.byteLength).toBe(4);
    expect(decodeUint32(bytes)).toBe(8 * 1024 * 1024);
  });

  it("round-trips zero and the maximum", () => {
    expect(decodeUint32(encodeUint32(0))).toBe(0);
    expect(decodeUint32(encodeUint32(0xffffffff))).toBe(0xffffffff);
  });

  it("clamps at the ceiling instead of wrapping to zero", () => {
    // `n >>> 0` makes each of these a different, smaller number: 0, 0 and 5.
    // The first two advertise no credit at all and hang the peer permanently.
    expect(decodeUint32(encodeUint32(2 ** 32))).toBe(0xffffffff);
    expect(decodeUint32(encodeUint32(8 * 1024 * 1024 * 1024))).toBe(0xffffffff);
    expect(decodeUint32(encodeUint32(2 ** 32 + 5))).toBe(0xffffffff);
  });

  it("clamps a negative, fractional or non-finite value into range", () => {
    expect(decodeUint32(encodeUint32(-1))).toBe(0);
    expect(decodeUint32(encodeUint32(1.9))).toBe(1);
    expect(decodeUint32(encodeUint32(Number.NaN))).toBe(0);
  });

  it("returns undefined for a payload shorter than four bytes", () => {
    expect(decodeUint32(new Uint8Array(0))).toBeUndefined();
    expect(decodeUint32(new Uint8Array(3))).toBeUndefined();
  });

  it("reads the first four bytes when the payload is longer", () => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setUint32(0, 12345, false);
    expect(decodeUint32(bytes)).toBe(12345);
  });

  it("reads through a non-zero byteOffset", () => {
    const backing = new Uint8Array(8);
    new DataView(backing.buffer).setUint32(4, 999, false);
    expect(decodeUint32(backing.subarray(4))).toBe(999);
  });
});
```

The last case is not padding: `decodeUint32` is called on `frame.subarray(...)`,
which is a view with a non-zero `byteOffset` over a larger buffer. A
`DataView(bytes.buffer)` that ignores `byteOffset` passes the first four cases
and reads the wrong four bytes in production.

Nor is the ceiling case theoretical. `maxStreamBuffer` is a caller-supplied
number and it is what gets advertised, so `n >>> 0` — the obvious spelling —
turns a 4 GiB window into an advertisement of **0 credit**. Measured on the
implemented mux with the wrapping encoder: a 4 GiB window transferred **0 of
4096 bytes in one second**, with no error and no timeout. That is precisely the
"silent permanent hang" this plan cites as the reason for `reserve(upTo)`,
reintroduced through the codec. `2 ** 32 + 5` is worse again: it wraps to 5, a
five-byte window that looks like it is working.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/uint32.test.ts
```

Expected: **exit 1, a startup error, and `Tests  no tests`** — the same shape as
Task 1 Step 2, not a failed assertion:

```
 FAIL  tests/uint32.test.ts [ tests/uint32.test.ts ]
Error: Cannot find module '../src/uint32.js' imported from <repo>/packages/webrun-streams/tests/uint32.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/webrun-streams/src/uint32.ts`:

```ts
/**
 * Credit payloads are a single big-endian uint32, matching the frame header's
 * byte order.
 *
 * Deliberately **not** re-exported from `index.ts`: this is an internal codec
 * for the `emulateMux` wire format, not a compatibility commitment. Tests
 * import it by path.
 */
/** The largest credit a single frame can advertise or grant: 2^32 - 1. */
export const MAX_UINT32 = 0xffffffff;

/**
 * Clamps rather than wraps. `n >>> 0` is the obvious spelling and it is wrong
 * here: 2^32 becomes **0**, so a 4 GiB window advertises *zero credit* and the
 * peer stalls forever with no error — the exact silent hang credit exists to
 * remove. 2^32 + 5 becomes 5, which looks like a working window and is worse.
 * Anything above the ceiling is advertised as the ceiling.
 */
export function encodeUint32(n: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const clamped = Number.isFinite(n) ? Math.min(MAX_UINT32, Math.max(0, Math.floor(n))) : 0;
  new DataView(bytes.buffer).setUint32(0, clamped, false);
  return bytes;
}

/**
 * Returns `undefined` rather than a garbage number when the payload is too
 * short, so a truncated frame — or one from a peer predating credit — is
 * detectable at the call site instead of silently granting nonsense.
 */
export function decodeUint32(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 4) return undefined;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}
```

Do **not** add it to `src/index.ts`.

- [ ] **Step 4: Run and verify pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/uint32.test.ts
pnpm --filter @statewalker/webrun-streams test
```

Expected: 7 tests in the new file; 151 in the package.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams/src/uint32.ts \
        packages/webrun-streams/tests/uint32.test.ts
git commit -m "feat(streams): uint32 payload codec for credit frames

decodeUint32 returns undefined below four bytes so a truncated frame is
detectable rather than granting a garbage amount, and reads through a
non-zero byteOffset so a subarray view decodes correctly.

encodeUint32 clamps into [0, MAX_UINT32] instead of using n >>> 0, which
turns a 4 GiB window into an advertisement of zero credit: measured, that
hangs a transfer permanently with no error.

Deliberately not exported from index.ts: index.ts is export-* over
emulate-mux.ts, so anything exported there is published API."
```

---

### Task 3: Credit on the wire

This is the behavioural change, and it is **one commit**. The wire-format change
(`OPEN`/`ACK` carry credit) and the behavioural change (`pumpOutbound` reserves,
inbound grants) are not separable: between them there is a state in which an
`ACK` means "advertisement" to one code path and "the frame you sent was
consumed" to another, and on any transport that defers delivery by a macrotask —
which is every real one — the OPEN-reply ACK would release the stop-and-wait
pump one frame early. No commit should ship that mux.

It **deliberately breaks** four tests in `emulate-mux-backpressure.test.ts` and
one in `emulate-mux.test.ts`, all of which pin stop-and-wait. Steps 6–8 rewrite
them in this same commit. Do not skip **Step 6**: watching them break is how you
know you changed the thing you meant to.

**Files:**
- Modify: `packages/webrun-streams/src/emulate-mux.ts`
- Create: `packages/webrun-streams/tests/emulate-mux-credit.test.ts`
- Modify: `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts`
- Modify: `packages/webrun-streams/tests/emulate-mux.test.ts`

**Interfaces:**
- Consumes: `newCreditLedger`/`newCreditGrantor` (Task 1), `encodeUint32`/`decodeUint32` (Task 2).
- Produces: `Stream` gains `outboundCredit: CreditLedger` and `grantor: CreditGrantor`, and loses `resolveAck`/`rejectAck`. No public signature changes.

- [ ] **Step 1: Write the failing tests**

Create `packages/webrun-streams/tests/emulate-mux-credit.test.ts`. The
`tracedPair` helper below is **supplied here, not copied from anywhere**: the
existing backpressure test has a different helper (`pipePair`, returning
`{ a, b, frames: string[] }`) with a different shape. Paste this block as it is.

```ts
import { describe, expect, it } from "vitest";
import { type ByteChannel, emulateMux } from "../src/index.js";

const FRAME_NAMES: Record<number, string> = {
  1: "OPEN",
  2: "DATA",
  3: "ACK",
  4: "END",
  5: "ERROR",
  6: "CLOSE",
};

/** Decodes the varint stream id, both to locate the type byte and to report it. */
function frameInfo(frame: Uint8Array): { id: number; type: string; payload: Uint8Array } {
  let offset = 0;
  let id = 0;
  let shift = 0;
  while (offset < frame.byteLength) {
    const byte = frame[offset++] ?? 0;
    id |= (byte & 0x7f) << shift;
    if (byte < 0x80) break;
    shift += 7;
  }
  const type = FRAME_NAMES[frame[offset] ?? 0] ?? "?";
  return { id, type, payload: frame.subarray(offset + 1) };
}

interface TracedPair {
  a: ByteChannel;
  b: ByteChannel;
  sent: { from: "a" | "b"; id: number; type: string; payload: Uint8Array }[];
}

function tracedPair(): TracedPair {
  const sent: TracedPair["sent"] = [];
  const queues: Record<"a" | "b", Uint8Array[]> = { a: [], b: [] };
  const pending: Record<"a" | "b", ((r: IteratorResult<Uint8Array>) => void) | null> = {
    a: null,
    b: null,
  };
  let closed = false;
  const closers: (() => void)[] = [];
  const closedPromise = new Promise<void>((r) => closers.push(r));

  const deliver = (to: "a" | "b", bytes: Uint8Array): void => {
    if (closed) return;
    const waiting = pending[to];
    if (waiting) {
      pending[to] = null;
      waiting({ value: bytes, done: false });
    } else queues[to].push(bytes);
  };

  const makeChannel = (self: "a" | "b", peer: "a" | "b"): ByteChannel => ({
    send(bytes) {
      const { id, type, payload } = frameInfo(bytes);
      sent.push({ from: self, id, type, payload: new Uint8Array(payload) });
      deliver(peer, new Uint8Array(bytes));
    },
    recv: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const queued = queues[self].shift();
          if (queued) {
            yield queued;
            continue;
          }
          const nextValue = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending[self] = resolve;
          });
          if (nextValue.done) return;
          yield nextValue.value;
        }
      },
    },
    closed: closedPromise,
    close() {
      closed = true;
      for (const c of closers) c();
      pending.a?.({ value: undefined as never, done: true });
      pending.b?.({ value: undefined as never, done: true });
    },
  });

  return { a: makeChannel("a", "b"), b: makeChannel("b", "a"), sent };
}

/** Total DATA bytes one side has put on the wire. */
function dataBytes(sent: TracedPair["sent"], from: "a" | "b"): number {
  return sent
    .filter((f) => f.from === from && f.type === "DATA")
    .reduce((sum, f) => sum + f.payload.byteLength, 0);
}

/** The same, split by stream id, so a per-stream claim has a witness. */
function dataBytesByStream(sent: TracedPair["sent"], from: "a" | "b"): Map<number, number> {
  const perStream = new Map<number, number>();
  for (const f of sent) {
    if (f.from !== from || f.type !== "DATA") continue;
    perStream.set(f.id, (perStream.get(f.id) ?? 0) + f.payload.byteLength);
  }
  return perStream;
}

describe("credit advertisement", () => {
  it("puts the opener's maxStreamBuffer in the OPEN payload", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 1 << 20 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    const open = sent.find((f) => f.from === "a" && f.type === "OPEN");
    expect(open).toBeDefined();
    const payload = (open as { payload: Uint8Array }).payload;
    expect(payload.byteLength).toBe(4);
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, false)).toBe(1 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });

  it("answers OPEN with an ACK carrying the responder's maxStreamBuffer, before anything else", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 2 << 20 });
    server.serve(async function* echo(input) {
      for await (const chunk of input) yield chunk;
    });

    const gen = client.call([new Uint8Array([1])]);
    await gen.next();

    // The FIRST frame b sends must be the advertisement. Searching for "some
    // ACK somewhere" would also match a drain grant and prove nothing about
    // which one answered OPEN.
    const first = sent.filter((f) => f.from === "b")[0];
    expect(first?.type).toBe("ACK");
    const payload = (first as { payload: Uint8Array }).payload;
    expect(payload.byteLength).toBe(4);
    expect(new DataView(payload.buffer, payload.byteOffset).getUint32(0, false)).toBe(2 << 20);

    await gen.return(undefined as never);
    await client.close();
    await server.close();
  });
});

describe("window bounds", () => {
  it("refuses a maxStreamBuffer of zero, which would authorise nothing", () => {
    const { a } = tracedPair();
    expect(() => emulateMux(a, { side: "initiator", maxStreamBuffer: 0 })).toThrow(RangeError);
  });

  it("transfers through a window larger than the uint32 credit field", async () => {
    // 4 GiB is 2^32 exactly. Encoding that advertisement with `n >>> 0` puts
    // **0** on the wire — no credit at all — and both sides stall silently
    // forever. Measured before the clamp: 0 of 4096 bytes after one second.
    const { a, b } = tracedPair();
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 4 * 1024 * 1024 * 1024 });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 8 * 1024 * 1024 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const gen = client.call([new Uint8Array(4096)]);
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    const deadline = Date.now() + 2000;
    while (received < 4096 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(4096);

    await client.close();
    await server.close();
  });
});

describe("credit bounds the sender", () => {
  it("never puts more bytes on the wire than the peer advertised", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4096 });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const gen = client.call(
      (async function* () {
        for (let i = 0; i < 40; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* stream torn down */
      }
    })();
    await new Promise((r) => setTimeout(r, 60));

    // 40 KiB offered, 4 KiB granted: the whole window and not one byte more.
    // A floor as well as a ceiling — `toBeLessThanOrEqual` alone is satisfied
    // by a mux that grants nothing and therefore sends nothing, which is not
    // the property this test exists to pin.
    expect(dataBytes(sent, "a")).toBe(4096);
    expect(sent.some((f) => f.from === "b" && f.type === "ERROR")).toBe(false);

    await client.close();
    await server.close();
  });

  it("bounds aggregate in-flight bytes at streams x window", async () => {
    const { a, b, sent } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4096 });
    server.serve(async function* neverDrains() {
      await new Promise((r) => setTimeout(r, 5_000));
    });

    const streams = 8;
    const gens = Array.from({ length: streams }, () =>
      client.call(
        (async function* () {
          for (let i = 0; i < 40; i++) yield new Uint8Array(1024);
        })(),
      ),
    );
    for (const gen of gens) {
      void (async () => {
        try {
          for await (const _c of gen) {
            /* drain */
          }
        } catch {
          /* stream torn down */
        }
      })();
    }
    await new Promise((r) => setTimeout(r, 80));

    // The window is per stream and there is no mux-wide budget, so the bound
    // the design offers is exactly this product. It is the number the README
    // must quote next to `maxStreamBuffer`.
    //
    // The floor and the per-stream witness are both load-bearing: an upper
    // bound alone is satisfied by a mux that grants nothing, and equally by
    // one that credits a single stream out of the eight — neither of which
    // establishes a per-stream product.
    const perStream = dataBytesByStream(sent, "a");
    expect(perStream.size).toBe(streams);
    for (const bytes of perStream.values()) expect(bytes).toBe(4096);
    expect(dataBytes(sent, "a")).toBe(streams * 4096);

    await client.close();
    await server.close();
  });
});

describe("credit replenishment", () => {
  it("a sender stalled at zero credit resumes once the consumer drains", async () => {
    const { a, b } = tracedPair();
    const client = emulateMux(a, { side: "initiator" });
    const server = emulateMux(b, {
      side: "responder",
      mtu: 1024,
      maxStreamBuffer: 4 * 1024,
    });

    let received = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    server.serve(async function* counting(input) {
      await gate;
      for await (const chunk of input) received += chunk.byteLength;
      // biome's `lint/correctness/useYield` is an error, not a warning, and a
      // handler that only consumes has no natural yield. An empty chunk is
      // skipped by `pumpOutbound`, so it costs no frame.
      yield new Uint8Array(0);
    });

    const total = 40;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    void (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    // Consumer is gated: the sender fills the window and stalls well short.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(0);

    // Open the gate; grants flow and the whole stream must complete.
    release();
    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });

  it("completes when the sender's mtu is larger than the peer's whole window", async () => {
    const { a, b } = tracedPair();
    // 64 KiB mtu on the caller, 4 KiB window on the responder. A sender that
    // framed at its own mtu and then reserved that much would park forever on
    // a reservation the peer can never cover.
    const client = emulateMux(a, { side: "initiator", mtu: 64 * 1024 });
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 4 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const gen = client.call([new Uint8Array(64 * 1024)]);
    const errors: unknown[] = [];
    try {
      for await (const _c of gen) {
        /* drain */
      }
    } catch (err) {
      errors.push(err);
    }

    const deadline = Date.now() + 2000;
    while (received < 64 * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(errors).toEqual([]);
    expect(received).toBe(64 * 1024);

    await client.close();
    await server.close();
  });
});

describe("asymmetric configuration", () => {
  it("a large-buffer sender and a small-buffer receiver transfer without teardown", async () => {
    const { a, b } = tracedPair();
    // The sender would happily hold 8 MiB; the receiver can hold 4 KiB.
    // Under a sender-side window each peer's local check passes and the
    // stream is torn down. Under credit the sender is simply granted less.
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 8 * 1024 * 1024 });
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 4 * 1024 });

    let received = 0;
    server.serve(async function* counting(input) {
      for await (const chunk of input) received += chunk.byteLength;
      yield new Uint8Array(0);
    });

    const total = 64;
    const gen = client.call(
      (async function* () {
        for (let i = 0; i < total; i++) yield new Uint8Array(1024);
      })(),
    );
    const errors: unknown[] = [];
    await (async () => {
      try {
        for await (const _c of gen) {
          /* drain */
        }
      } catch (err) {
        errors.push(err);
      }
    })();

    const deadline = Date.now() + 2000;
    while (received < total * 1024 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(errors).toEqual([]);
    expect(received).toBe(total * 1024);

    await client.close();
    await server.close();
  });
});

describe("sub-threshold traffic", () => {
  // Regression test, not a TDD cycle. The protocol review found a permanent
  // deadlock here: with a `spend(exact)` ledger the sender parks needing more
  // than the window's remainder, and with an unflushed grantor the receiver's
  // 300-byte drain stays below the 512-byte trigger, so neither side moves.
  //
  // Be precise about what kills this test, because an earlier draft was not.
  // It is the **pair** of those two changes, not either one alone: measured,
  // `spend(exact)` with the flush intact leaves it green (1 failed | 9 passed
  // in this file), dropping only the flush leaves it green (0 failed here),
  // and applying both fails it on `expected 300 to be 1200` — the sender got
  // exactly its first chunk out and then stopped. That pair is a row in
  // Step 5's mutation table, so this test's claim to be load-bearing is
  // checked rather than asserted.
  it("completes a response whose chunks straddle the batching threshold", async () => {
    const { a, b } = tracedPair();
    // 1 KiB window, so grants batch at 512 bytes; 300 then 900 against it.
    const client = emulateMux(a, { side: "initiator", mtu: 1024, maxStreamBuffer: 1024 });
    const server = emulateMux(b, { side: "responder" });
    server.serve(async function* twoChunks() {
      yield new Uint8Array(300);
      await new Promise((r) => setTimeout(r, 20));
      yield new Uint8Array(900);
    });

    let received = 0;
    const drained = (async () => {
      for await (const chunk of client.call([])) {
        received += chunk.byteLength;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await Promise.race([drained, new Promise((r) => setTimeout(r, 1500))]);
    expect(received).toBe(1200);

    await client.close();
    await server.close();
  });
});
```

Six of those ten tests are red before Step 3 and green after; the other four are
guards. Step 2 and Step 5 say which is which and prove it.

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: FAIL, **6 failed | 4 passed (10)**. The six, with their exact
messages:

- `puts the opener's maxStreamBuffer in the OPEN payload` —
  `AssertionError: expected +0 to be 4`, at `expect(payload.byteLength).toBe(4)`.
  `OPEN` carries no payload today.
- `answers OPEN with an ACK carrying the responder's maxStreamBuffer, before anything else` —
  `AssertionError: expected 'DATA' to be 'ACK'`. Note the reason: it is **not**
  that no ACK exists. Today's responder already ACKs every drained chunk
  (`emulate-mux.ts:342`), so a test that searched for "some ACK from b" would
  find one and prove nothing. The first frame `b` sends today is the echoed
  DATA, because nothing answers `OPEN` at all.
- `refuses a maxStreamBuffer of zero, which would authorise nothing` —
  `AssertionError: expected function to throw an error, but it didn't`. Today
  `maxStreamBuffer` is only a cap, so 0 is merely a very small cap; once it is
  also the advertisement, 0 is an unrecoverable stall. Step 3 adds the guard.
- `never puts more bytes on the wire than the peer advertised` —
  `AssertionError: expected 1024 to be 4096`. Stop-and-wait puts exactly one
  1 KiB frame on the wire and waits; the window is 4 KiB. The **floor** is what
  makes this red — an upper bound alone is satisfied by stop-and-wait, and
  equally by a mux that sends nothing at all.
- `bounds aggregate in-flight bytes at streams x window` —
  `AssertionError: expected 1024 to be 4096`, from the per-stream loop, for the
  same reason.
- `completes when the sender's mtu is larger than the peer's whole window` —
  `AssertionError: expected [ …(1) ] to deeply equal []`. Today the caller frames
  a whole 64 KiB chunk and sends it at a peer whose `maxStreamBuffer` is 4 KiB,
  so the receiver's overflow guard fires and the caller's `for await` throws.

The four that pass — `transfers through a window larger than the uint32 credit
field`, `a sender stalled at zero credit resumes…`, `a large-buffer sender and a
small-buffer receiver…` and `completes a response whose chunks straddle the
batching threshold` — are satisfied by stop-and-wait too. They are there to
catch a *wrong* credit implementation, which is a different job from catching
*no* credit implementation. Step 5 names a mutation that kills each of the four,
with the measured output.

- [ ] **Step 3: Implement**

In `packages/webrun-streams/src/emulate-mux.ts`:

**3a.** Extend the imports at the top of the file:

```ts
import { deserializeError, serializeError } from "./errors.js";
import {
  type CreditGrantor,
  type CreditLedger,
  newCreditGrantor,
  newCreditLedger,
} from "./flow-control.js";
import { decodeUint32, encodeUint32 } from "./uint32.js";
```

**3b.** In the `Stream` interface, replace the two ACK-resolver fields

```ts
  resolveAck: (() => void) | null;
  rejectAck: ((err: Error) => void) | null;
```

with

```ts
  /** Credit the peer has granted us for sending on this stream. */
  outboundCredit: CreditLedger;
  /** Tracks consumer drainage to decide when to grant the peer more credit. */
  grantor: CreditGrantor;
```

**3c.** In `teardownStream`, replace the six lines that juggle those fields —
`const resolve = s.resolveAck;` through `else resolve?.();` (currently lines
149–154) — with one:

```ts
    // A sender parked in `reserve()` unwinds here: the credit it is waiting
    // for will never arrive, so fail the ledger rather than leave it queued.
    s.outboundCredit.fail(err ?? new TransportClosedError("emulateMux: stream closed"));
```

Six, not two: lines 149–152 read and null the fields, 153–154 call them.
Deleting only the calls leaves four references to fields this step removes, and
`tsc` fails with `TS2339`.

**3c-bis.** `maxStreamBuffer` stops being only a cap and becomes the credit this
side advertises, so two of its values become unusable. Widen its JSDoc on
`EmulateMuxOptions` — replace

```ts
  /**
   * Cap on inbound bytes one stream may hold for a consumer that has not
   * drained them. Exceeding it tears down that stream alone.
   */
  maxStreamBuffer?: number;
```

with

```ts
  /**
   * Cap on inbound bytes one stream may hold for a consumer that has not
   * drained them. Exceeding it tears down that stream alone.
   *
   * It is also the credit this side advertises to the peer, so it must be at
   * least 1 — a window of 0 authorises nothing and hangs the peer forever —
   * and it travels in a uint32, so a value above `MAX_UINT32` (4 GiB - 1) is
   * advertised as `MAX_UINT32`.
   */
  maxStreamBuffer?: number;
```

and reject the unusable one at construction. Immediately after
`const maxStreamBuffer = opts.maxStreamBuffer ?? DEFAULT_MAX_STREAM_BUFFER;`:

```ts
  // A window of 0 is not a small window, it is a permanent stall: the peer is
  // authorised to send nothing and no event would ever grant it more. Refuse
  // it at construction rather than deadlocking on the first call.
  if (!(maxStreamBuffer >= 1)) {
    throw new RangeError(`emulateMux: maxStreamBuffer must be at least 1, got ${maxStreamBuffer}`);
  }
```

The upper end needs no guard here because Task 2's `encodeUint32` clamps; that
is the whole point of the clamp, and Step 5's table has a row proving it.

**3d.** In `createStream`, replace `resolveAck: null,` / `rejectAck: null,` with:

```ts
      outboundCredit: newCreditLedger(0),
      grantor: newCreditGrantor(maxStreamBuffer),
```

**3e.** Replace the inner `while (off < chunk.byteLength)` body of `pumpOutbound` (currently lines 210–221):

```ts
        let off = 0;
        while (off < chunk.byteLength) {
          if (s.closed || muxClosed) return;
          // Reserve BEFORE framing. `reserve` returns what the peer's window
          // can actually take, up to one mtu, so a piece is never larger than
          // the credit that exists for it — which is what stops a sender whose
          // mtu exceeds the peer's whole window from stalling forever.
          const take = await s.outboundCredit.reserve(Math.min(mtu, chunk.byteLength - off));
          if (s.closed || muxClosed) return;
          const end = off + take;
          sendFrame(s.id, TYPE_DATA, chunk.subarray(off, end));
          off = end;
        }
```

**3f.** In `call`, carry the advertisement — replace `sendFrame(id, TYPE_OPEN);`:

```ts
    sendFrame(id, TYPE_OPEN, encodeUint32(maxStreamBuffer));
```

**3g.** In the inbound `TYPE_OPEN` branch, between `streams.set(id, s);` and `void runHandler(s, handler);`:

```ts
      // The opener's advertisement is our whole sending allowance; our own
      // goes back so the opener can start. Both ledgers begin at zero, so the
      // advertisement and every later grant are the same operation — an
      // increment — and the ACK handler needs no special first case.
      const advertised = decodeUint32(payload);
      if (advertised !== undefined) s.outboundCredit.grant(advertised);
      sendFrame(id, TYPE_ACK, encodeUint32(maxStreamBuffer));
```

**3h.** Replace the `pushIn` continuation in the `TYPE_DATA` branch (currently lines 340–343):

```ts
        void s.pushIn(copy).then((handled) => {
          s.queuedBytes -= copy.byteLength;
          if (!handled || s.closed || muxClosed) return;
          // Grant only for bytes the consumer actually took, batched while the
          // receiver is behind and flushed the moment its queue empties.
          const grant = s.grantor.consumed(copy.byteLength, s.queuedBytes === 0);
          if (grant > 0) sendFrame(id, TYPE_ACK, encodeUint32(grant));
        });
```

**3i.** Replace the `TYPE_ACK` branch (currently lines 346–352):

```ts
      case TYPE_ACK: {
        const granted = decodeUint32(payload);
        // A payload-less ACK is not from a credit-speaking peer; ignore it
        // rather than granting an arbitrary amount.
        if (granted !== undefined) s.outboundCredit.grant(granted);
        return;
      }
```

**3j.** Two comments in the same file still describe stop-and-wait. Replace the
opening comment of the `TYPE_DATA` branch:

```ts
        // Flow control is the peer spending only the credit we granted it —
        // voluntary, and a hostile peer simply does not. Pushes are
        // fire-and-forget by necessity (see the comment below), so nothing
        // else bounds this queue: a peer that floods DATA at a handler which
        // has not started draining retains every payload. Refuse past a
        // per-stream cap and tear down THAT stream, never the whole mux.
```

and the one immediately above `void s.pushIn(copy)`:

```ts
        // Push fire-and-forget; grant after the consumer drains. The inbound
        // loop must NOT block on consumer drainage — our own sender is parked
        // in `reserve()` waiting for the peer's grants, so blocking here
        // causes a cross-direction deadlock where ACK frames can't be
        // processed.
```

The second is quoted verbatim in the spec's Finding 7. The spec describes the
code as it was when the finding was made and is not edited here; this plan's
own README updates (Steps 8 and 9) are what carry the new description forward.

- [ ] **Step 4: Run the credit tests and verify they pass**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-credit.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the guard tests are not vacuous**

Eight mutations, one at a time, reverted after each. Every row below was applied
and run against `tests/emulate-mux-credit.test.ts`; the **measured** totals are
in the third column, and the "turns red" column is the exact failure set, not a
lower bound. If your totals differ, stop — the same rule Step 6 states.

| mutation | turns red | measured |
| --- | --- | --- |
| `newCreditLedger(65536)` in `createStream` — an unearned bootstrap allowance | `never puts more bytes on the wire…`, `bounds aggregate in-flight bytes…`, `a sender stalled at zero credit resumes…`, `completes when the sender's mtu is larger…`, `completes a response whose chunks straddle…` | `5 failed \| 5 passed (10)` |
| delete the `sendFrame(id, TYPE_ACK, encodeUint32(grant))` line in 3h | `a sender stalled at zero credit resumes…`, `completes when the sender's mtu is larger…`, `a large-buffer sender and a small-buffer receiver…`, `completes a response whose chunks straddle…` | `4 failed \| 6 passed (10)` |
| in 3e, loop until the full `mtu` is reserved instead of taking what fits | `completes when the sender's mtu is larger than the peer's whole window` | `1 failed \| 9 passed (10)` |
| in `uint32.ts`, restore `setUint32(0, n >>> 0, false)` (wrap instead of clamp) | `transfers through a window larger than the uint32 credit field` | `1 failed \| 9 passed (10)` |
| in `flow-control.ts`, make the ledger `spend(exact)` — release a waiter only when `available >= upTo` and take `upTo` — **and** drop the grantor's flush (`if (pending < trigger) return 0;`) | `completes when the sender's mtu is larger…`, `completes a response whose chunks straddle the batching threshold` | `2 failed \| 8 passed (10)` |
| delete **both** grant sites — the OPEN-payload grant in 3g and the ACK grant in 3i — so no credit ever exists | all ten | `9 failed \| 1 passed (10)`, the survivor being `refuses a maxStreamBuffer of zero`, which never opens a stream |
| delete `s.outboundCredit.fail(...)` from `teardownStream` in 3c | `a sender parked in reserve unwinds when its stream is torn down` (added in Step 1) | `1 failed \| 11 passed (12)`. **Measured twice during execution**, superseding this row's earlier "unmeasured" note and its claim that the deletion left everything green — that was true only while the mandated teardown case was missing. The test fails on `expect(producerFinally).toBe(true)`, so it witnesses the producer's `finally` running rather than merely the absence of a throw |
| in 3h, pass a constant `true` for `queueEmpty` | `splits a chunk larger than mtu and gets credit back for every byte` (its frame-economy bound, Step 8f) | **unmeasured — measure before relying on it.** Reported as restoring one grant per DATA frame with the rest of the suite green |

Every one of the four tests that were already green at Step 2 appears in at
least one row, which is what makes the claim in Step 2 true rather than
decorative.

**Step 1 must also add a `credit teardown` case** covering 3c's
`outboundCredit.fail(...)`, which is otherwise dead weight no test touches:
open a stream, let the sender park in `reserve()` with zero credit, tear the
stream down, and assert the producer's `finally` runs (a flag set in the
generator's `finally`, awaited with a short deadline). Without it, deleting
that line is invisible.

The first mutation is the design this plan replaced; it is in the table because
five reviews found it in the previous draft and one reproduced it as a
conformant sender being torn down. If it ever goes green again, these tests
stopped working.

Selected measured output, to compare against:

```
=== M1: newCreditLedger(65536) ===
AssertionError: expected 6144 to be 4096       (never puts more bytes on the wire…)
AssertionError: expected 28672 to be 4096      (bounds aggregate in-flight bytes…)
      Tests  5 failed | 5 passed (10)

=== M5: spend(exact) AND no flush ===
 FAIL  … > sub-threshold traffic > completes a response whose chunks straddle the batching threshold
AssertionError: expected 300 to be 1200
      Tests  2 failed | 8 passed (10)

=== M6: both grant sites deleted ===
AssertionError: expected +0 to be 4096         (never puts more bytes on the wire…)
AssertionError: expected +0 to be 8            (bounds aggregate…, the per-stream witness)
      Tests  9 failed | 1 passed (10)
```

M6 is the one to keep in mind when editing these tests. Before the floors were
added, the two `credit bounds the sender` tests were pure upper bounds and this
mutation left **both green** while failing 34 other tests elsewhere in the
package — coverage that read as coverage and was not.

- [ ] **Step 6: Watch the stop-and-wait tests break**

```bash
pnpm --filter @statewalker/webrun-streams test
```

Expected: **5 failed | 158 passed** (163 total), in exactly two files:

- `emulate-mux-backpressure.test.ts` — `a slow consumer throttles the producer,
  in the request direction` and `…in the response direction too` both assert
  `ahead <= 2`, which is lock-step, not throttling: their chunks are ~8 bytes
  and their window is the 8 MiB default, four orders of magnitude larger, so the
  producer finishes all 50 in the first few microtasks. `holds exactly one DATA
  frame in flight while the peer never acks` asserts the contract this task
  replaces. `splits a chunk larger than mtu and acks each piece` counts
  `B>A:ACK` frames, and grants are no longer one per piece.
- `emulate-mux.test.ts` — `keeps pumping outbound after the peer's END, and
  frees the slot at our own END` times out at 5000 ms. It hand-rolls a peer at
  the frame level that replies `[id, TYPE_ACK]` with no payload and never
  answers `OPEN`, so the client is granted nothing and sends nothing.

If you see a different set, stop: something else changed.

- [ ] **Step 7: Rewrite the frame-level peer in `emulate-mux.test.ts`**

In `keeps pumping outbound after the peer's END…`, replace the constants and the
inbound loop:

```ts
    const TYPE_OPEN = 0x01;
    const TYPE_DATA = 0x02;
    const TYPE_ACK = 0x03;
    const TYPE_END = 0x04;
    const dec = new TextDecoder();
    const received: string[] = [];
    let sentEarlyEnd = false;

    // This hand-rolled peer must speak credit now: the client starts at zero
    // and sends nothing until an advertisement arrives.
    const ack = (id: number, credit: number): Uint8Array => {
      const frame = new Uint8Array(6);
      frame[0] = id;
      frame[1] = TYPE_ACK;
      new DataView(frame.buffer).setUint32(2, credit, false);
      return frame;
    };

    void (async () => {
      for await (const frame of b.recv) {
        const id = frame[0] as number;
        const type = frame[1];
        if (type === TYPE_OPEN) {
          b.send(ack(id, 64 * 1024));
        } else if (type === TYPE_DATA) {
          received.push(dec.decode(frame.subarray(2)));
          b.send(ack(id, frame.byteLength - 2));
          if (!sentEarlyEnd) {
            // Our side is done replying while theirs is still going.
            sentEarlyEnd = true;
            b.send(new Uint8Array([id, TYPE_END]));
          }
        }
      }
    })();
```

Nothing else in the test changes: it still asserts all three chunks arrived and
that the slot was freed despite `maxStreams: 1`.

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 8: Rewrite the four backpressure tests**

In `packages/webrun-streams/tests/emulate-mux-backpressure.test.ts`:

**8a.** Replace the file's header comment, which describes the old contract:

```ts
// Flow control here is receiver-advertised credit. Each side puts its
// `maxStreamBuffer` in the frame it opens with (`OPEN`, and the `ACK` that
// answers it); the sender reserves credit before it frames anything and stalls
// at zero; the receiver grants more only once its consumer has actually
// drained — `slot.resolve(true)` runs after the `yield` returns. Without it a
// fast producer would run ahead of a slow consumer without limit.
//
// None of this was pinned by any test: removing the ACK await from
// pumpOutbound entirely left the whole suite green. These cover it.
```

**8b.** Teach `pipePair` to record the credit each ACK carries, so an assertion
can be about credit rather than about frame counts. Replace its signature and
the first two lines of `deliver`:

```ts
/** One credit-bearing ACK, as observed on the wire. */
interface Grant {
  dir: "A>B" | "B>A";
  credit: number;
}

function pipePair(): {
  a: ByteChannel;
  b: ByteChannel;
  frames: string[];
  grants: Grant[];
} {
```

```ts
  const frames: string[] = [];
  const grants: Grant[] = [];
  const deliver = (t: "a" | "b", x: Uint8Array): void => {
    const dir = t === "b" ? "A>B" : "B>A";
    frames.push(`${dir}:${FRAME_NAMES[x[1]] ?? x[1]}`);
    // Single-byte stream ids only — every test here stays well under 128.
    if (x[1] === 3 && x.byteLength === 6) {
      grants.push({ dir, credit: new DataView(x.buffer, x.byteOffset + 2, 4).getUint32(0, false) });
    }
```

and add `grants,` beside `frames,` in the returned object.

**8c.** `a slow consumer throttles the producer, in the request direction` —
give the *receiving* side a window comparable to the payload, and restate the
bound in credit terms. Replace the mux construction:

```ts
    // NOTE: destructure `frames` from `pipePair()` here — the ERROR assertion
    // below needs it.
    const client = emulateMux(a, { side: "initiator" });
    // ~8-byte chunks against a 32-byte window: about four may be in flight.
    // At the 8 MiB default the window is four orders of magnitude larger than
    // the whole stream and nothing would ever throttle.
    const server = emulateMux(b, { side: "responder", maxStreamBuffer: 32 });
```

and the assertions:

```ts
    // The producer may run up to one credit window ahead — 32 bytes, i.e.
    // four `chunk-NN` chunks, plus the one being framed.
    //
    // The upper bound alone does NOT pin credit: delete `reserve` from 3e and
    // this test still passes, because the receiver's maxStreamBuffer guard
    // tears the stream down and the teardown does the throttling. The two
    // assertions below are what make it a credit test rather than a cap test.
    expect(frames.filter((f) => f.endsWith(":ERROR")).length).toBe(0); // no teardown
    expect(produced).toBeGreaterThanOrEqual(4);                        // window really filled
    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(6);
    expect(produced).toBeLessThan(50);
```

**8d.** `…in the response direction too` — here the *client* is the receiver:

```ts
    // The client is the receiver in this direction, so the small window goes
    // on the client.
    const client = emulateMux(a, { side: "initiator", maxStreamBuffer: 32 });
    const server = emulateMux(b, { side: "responder" });
```

```ts
    // `r-NN` is 3-4 bytes, so a 32-byte window holds eight to ten, plus the
    // one being framed — hence the bound of 11.
    //
    // As in 8c, the ERROR and floor assertions are what distinguish credit
    // from the buffer cap; without them this passes with `reserve` deleted.
    expect(frames.filter((f) => f.endsWith(":ERROR")).length).toBe(0);
    expect(produced).toBeGreaterThanOrEqual(8);
    expect(consumed).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(11);
    expect(produced).toBeLessThan(50);
```

**8e.** `holds exactly one DATA frame in flight while the peer never acks` —
rename and re-point it at the credit bound. The `it(...)` title becomes
`sends up to the advertised credit and no further while the peer never drains`,
the server gains an explicit window:

```ts
    const client = emulateMux(a, { side: "initiator" });
    // Four frames' worth of credit: the sender may fill it, then must stop.
    const server = emulateMux(b, {
      side: "responder",
      mtu: 64 * 1024,
      maxStreamBuffer: 4 * 64 * 1024,
    });
```

and the single assertion becomes three:

```ts
    // Unbounded sending would put all 50 on the wire. Credit bounds it to the
    // advertised window, and the consumer never drains so none is returned.
    const sentData = frames.filter((f) => f === "A>B:DATA").length;
    expect(sentData).toBeGreaterThan(1);
    expect(sentData).toBeLessThanOrEqual(4);
```

**8f.** `splits a chunk larger than mtu and acks each piece` — grants are
batched now, so counting ACK frames pins an implementation detail. Rename it to
`splits a chunk larger than mtu and gets credit back for every byte`, take
`grants` from the pair, and give the server a window small enough that the
sender genuinely stalls:

```ts
    const { a, b, frames, grants } = pipePair();
    const client = emulateMux(a, { side: "initiator", mtu: 1024 });
    // A 2 KiB window against an 8 KiB body: the sender genuinely stalls and
    // resumes several times, so the grants below are load-bearing.
    const server = emulateMux(b, { side: "responder", mtu: 1024, maxStreamBuffer: 2048 });
```

```ts
    expect(total).toBe(8 * 1024);
    expect(frames.filter((f) => f === "A>B:DATA").length).toBe(8);
    // Credit returned by the responder is its 2048-byte advertisement plus
    // exactly one byte of grant per byte its handler drained. How the grants
    // are batched is an implementation detail; the total is not.
    const returned = grants
      .filter((g) => g.dir === "B>A")
      .reduce((sum, g) => sum + g.credit, 0);
    expect(returned).toBe(2048 + 8 * 1024);
    // Frame economy — this is the ONLY integration coverage of `consumed`'s
    // `queueEmpty` argument. Hard-coding it to `true` restores one grant per
    // DATA frame (9 for 8) and the totals above stay green, so without this
    // bound the whole flush parameter is untested end to end.
    expect(grants.filter((g) => g.dir === "B>A").length).toBeLessThan(8);
```

- [ ] **Step 9: Run the whole package suite**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-backpressure.test.ts
pnpm --filter @statewalker/webrun-streams test
```

Expected: 5 tests in the backpressure file; **163** in the package (131 before
this plan, +13 Task 1, +7 Task 2, +12 Task 3). The Task 3 figure is 12, not 10,
because Step 5 mandates a `credit teardown` case that Step 1's code block omits,
and a ledger-level `grant()`-after-`fail()` assertion closes a gap Task 1's
review parked. Both are load-bearing: deleting `outboundCredit.fail(...)` kills
the first and nothing else, and removing the ledger's post-`fail` guard kills the
second and nothing else. Later tasks quoting a pre-Task-3 total are +2. `emulate-mux-hostile.test.ts`'s
19 tests are among them and must all still pass — in particular `caps what one
undrained stream may buffer, and spares the rest of the mux`, which is Task 4's
subject. If it fails here, stop and fix this task: the `queuedBytes` accounting
behind the cap must stay independent of credit, because a hostile peer by
definition does not participate in credit.

Run the backpressure file three or four times. Three of its five tests are
wall-clock scheduled (`setTimeout` at 20 ms against a 100 ms checkpoint); if one
is flaky at these bounds, widen the bound and say why in the comment rather than
re-rolling the dice.

- [ ] **Step 10: Run the two ungated adapter conformance suites**

`emulateMux`'s wire format just changed and four adapters embed it. The Global
Constraints require the conformance suite to be green at every commit, and
`webrun-streams`' own tests cannot observe it — they only exercise in-process
pipes, which deliver synchronously.

```bash
pnpm --filter @statewalker/webrun-streams-conformance test
pnpm --filter @statewalker/webrun-streams-ws test
pnpm --filter @statewalker/webrun-streams-port test
```

Expected: 20, 10 and 34 tests, all passing. (The first three grow in Task 5;
here they should be unchanged, because nothing outside `webrun-streams` has been
touched yet.)

- [ ] **Step 11: Update the two READMEs that describe the old behaviour**

In `packages/webrun-streams/README.md`, the `### Flow control` subsection at
line 254 — the one **under `## \`emulateMux\``**, not the `### Credit` group
Task 1 added under `## Exports` — has three paragraphs. Replace the **first**
one (`One in-flight DATA frame per stream. …`) with:

```markdown
Receiver-advertised credit. Each side puts its `maxStreamBuffer` in the frame it
opens with — `OPEN` for the caller, the `ACK` answering it for the responder —
and the sender may only send what it has been granted. Both sides start at zero,
so a caller pays one round trip per stream before its first DATA frame and none
thereafter. The receiver grants more once its consumer has actually drained,
batched at half the window and flushed as soon as its queue empties. A sender
therefore cannot overrun the receiver's buffer, and `maxStreamBuffer` bounds only
peers that ignore the protocol.
```

Keep the two paragraphs after it — "Backpressure is **per-stream**…" and "There
is deliberately **no stall timeout**…" — both are still true. Amend the second
of them by appending one sentence, because the number changed by two orders of
magnitude:

```markdown
The bound is per stream and there is no mux-wide budget, so the worst case is
`maxStreams × maxStreamBuffer` — 2 GiB at the defaults, against 16 MiB under the
one-frame-in-flight rule this replaced. Lower `maxStreamBuffer` if that matters
more than throughput.
```

In the same file's `## \`emulateMux\`` option table (line 252), replace the
`maxStreamBuffer` row's Purpose cell:

```markdown
| `maxStreamBuffer` | `8388608` | The credit this side advertises to the peer, in bytes, and the hard cap on inbound bytes one stream may hold undrained. A peer that honours credit never reaches the cap; one that ignores it has that stream torn down. |
```

In the root `README.md`, the `webrun-streams` bullet wraps the target string
across lines 139–140 with leading indentation, so a single-line find/replace
matches nothing. Replace exactly these two lines:

```
  and `emulateMux` (multi-stream over a single channel, with backpressure, a
  64 KiB default MTU and an 8 MiB per-stream buffer).
```

with:

```
  and `emulateMux` (multi-stream over a single channel, with receiver-advertised
  credit flow control, a 64 KiB default MTU and an 8 MiB per-stream credit
  window).
```

- [ ] **Step 12: Lint and commit**

The package lint exits 0 here, with the same single pre-existing
`noNonNullAssertion` warning inside `decodeVarint` that Task 1 Step 7 named —
now at `src/emulate-mux.ts:552`, because this task adds 30 lines above it.

That exit code is not free, and the reason is worth knowing before you edit the
test file: `lint/correctness/useYield` is an **error** in this repo, not a
warning, and it is not fixable by `--write`. Three of the handlers in Step 1's
file (`counting` in `credit replenishment` twice, and in `asymmetric
configuration`) plus the one in `window bounds` only consume their input, so
each carries a terminal `yield new Uint8Array(0);`. Measured without them:
`4 errors`, exit 1, at `tests/emulate-mux-credit.test.ts:169:18`, `294:18`,
`343:18` and `379:18`. `pumpOutbound` skips a zero-length chunk, so the yields
cost no frame and no assertion changes.

```bash
pnpm --filter @statewalker/webrun-streams lint
git add packages/webrun-streams/src/emulate-mux.ts \
        packages/webrun-streams/tests/emulate-mux-credit.test.ts \
        packages/webrun-streams/tests/emulate-mux-backpressure.test.ts \
        packages/webrun-streams/tests/emulate-mux.test.ts \
        packages/webrun-streams/README.md \
        README.md
git commit -m "feat(streams)!: receiver-advertised credit instead of one ACK per frame

Both ledgers start at zero. OPEN carries the opener's maxStreamBuffer, the
ACK answering it carries the responder's, and every later ACK is an
incremental grant — so advertisement and replenishment are the same
operation and cannot disagree. pumpOutbound reserves before it frames and
takes what the window can cover, so a sender whose mtu exceeds the peer's
whole window makes progress instead of parking forever.

Single-stream throughput stops being one round trip per 64 KiB frame; a
caller pays one round trip per stream instead.

Backpressure is preserved at coarser granularity: the producer may run one
credit window ahead of the consumer rather than exactly zero. Aggregate
worst case rises from maxStreams x mtu to maxStreams x maxStreamBuffer.

BREAKING: OPEN and ACK carry uint32 payloads. Peers predating this cannot
interoperate. Replaces four tests that pinned stop-and-wait, and teaches
the frame-level peer in emulate-mux.test.ts to speak credit."
```

---

### Task 4: The buffer cap still defends against peers ignoring credit

`maxStreamBuffer` must keep its original job while never firing for peers that
honour credit. `emulate-mux-hostile.test.ts` already has the test that proves
it — "caps what one undrained stream may buffer, and spares the rest of the
mux" — so this task verifies it survived Task 3, corrects its now-wrong
explanation, and adds an assertion about what the hostile peer was actually
granted.

> **This is a regression task, not a TDD cycle.** The behaviour predates this
> plan; the point is to prove it was not lost. Step 4 does supply a mutation
> that turns the new assertion red, so the assertion itself is not vacuous.

**Files:**
- Modify: `packages/webrun-streams/tests/emulate-mux-hostile.test.ts`

**Interfaces:**
- Consumes: the credit path on `emulate-mux.ts` from Task 3 — specifically 3g's
  `ACK`-with-advertisement reply and the `queuedBytes` accounting behind the cap.
- Produces: nothing. No later task depends on this one.

- [ ] **Step 1: Run the existing hostile suite unchanged**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-hostile.test.ts
```

Expected: PASS, **19 tests** — 16 cases from the `it.each(HOSTILE)` table at
line 104 plus three standalone `it` blocks at lines 122, 142 and 188. (Counting
`describe` blocks gives four; that is not what vitest reports.)

If it **fails**, stop and fix Task 3: the `queuedBytes` accounting behind the
cap must stay independent of credit. Do not weaken the test.

- [ ] **Step 2: Correct the stale explanation**

That test's opening comment (lines 143–145) still describes stop-and-wait.
Replace those three lines:

```ts
    // Credit is voluntary: the peer is meant to spend only what it was
    // granted and wait for more. A hostile peer does not, and pushes are
    // fire-and-forget, so without a cap one stream retains everything sent.
```

- [ ] **Step 3: Assert what the hostile peer was granted**

Immediately after the two existing `refusal` assertions, add:

```ts
    // The peer was handed the whole window and ignored it. Exactly one
    // credit-bearing ACK went out — the reply to its OPEN, carrying the
    // responder's 256 KiB `maxStreamBuffer` — and no drain grant followed,
    // because the handler never drained. So the cap is what stopped the
    // flood, not flow control: a peer that honours credit could never have
    // sent more than that one advertisement.
    const TYPE_ACK = 0x03;
    const grants = sentToA.filter((f) => f[0] === 0x03 && f[1] === TYPE_ACK);
    expect(grants.length).toBe(1);
    const advertised = grants[0] as Uint8Array;
    expect(advertised.byteLength).toBe(6);
    expect(new DataView(advertised.buffer, advertised.byteOffset + 2, 4).getUint32(0, false)).toBe(
      256 * 1024,
    );
```

Note what this does *not* say. The injected `OPEN` is `new Uint8Array([0x03, 0x01])`
— two bytes, no payload — so `decodeUint32` returns `undefined` and the
responder's *own* outbound ledger stays at zero. That is a different fact from
what the responder grants the peer, which is the full advertisement,
unconditionally. An earlier draft asserted `grants.length <= 1` with a comment
saying the responder "granted nothing"; both halves were wrong, and the
assertion could not fail under any implementation.

- [ ] **Step 4: Run, verify green, and check the assertion can fail**

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/emulate-mux-hostile.test.ts
```

Expected: PASS, 19 tests.

Then, as a one-off check: change Task 3 Step 3g's reply to
`sendFrame(id, TYPE_ACK);` (drop the payload) and re-run. Expected: **19 failed**
— every hostile case depends on a live mux, and a client granted nothing cannot
complete the control round trip each of them ends with; the case under edit
fails on `expected 2 to be 6`. Revert.

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-streams/tests/emulate-mux-hostile.test.ts
git commit -m "test(streams): pin that the buffer cap survived the credit change

Credit bounds cooperative peers; maxStreamBuffer bounds the rest. The
hostile peer is handed a full 256 KiB advertisement on its injected OPEN
and ignores it, so only the cap stops the flood — asserted rather than
assumed."
```

> The hostile peer's `OPEN` is payload-less, so `decodeUint32` returns
> `undefined` on that path — but nothing here *pins* that behaviour: granting an
> arbitrary amount instead leaves all 19 hostile tests green, because the cap
> fires either way. If you want that pinned, add a unit case in
> `emulate-mux-credit.test.ts` injecting a two-byte `ACK` and asserting no DATA
> follows. Do not claim it in the commit message otherwise.

---

### Task 5: Adapters accept mux options; conformance covers flow control

L6 has to be able to fail. At every adapter's defaults — 64 KiB MTU, 8 MiB
window — no body a conformance suite can reasonably move exhausts the credit,
so nothing stalls and no grant is ever emitted: a level written against those
defaults passes identically with credit deleted. The fix is to let the suite ask
for a small window, which means the four `emulateMux`-based adapters must accept
one.

**Files:**
- Modify: `packages/webrun-streams-conformance/src/loopback.ts`, `src/index.ts`, `src/describe-duplex-adapter.ts`
- Modify: `packages/webrun-streams-ws/src/{connect,serve}.ts`, `packages/webrun-streams-port/src/connect-serve.ts`, `packages/webrun-streams-peerjs/src/connect-serve.ts`, `packages/webrun-streams-livekit/src/connect-serve.ts`
- Modify: `packages/webrun-streams-{ws,port}/tests/*` (their pair factories forward the tuning)
- Modify: `packages/webrun-streams-conformance/tests/emulate-mux.test.ts`
- Modify: `README.md`, `docs/adr/0004-duplex-as-seam.md` and five package READMEs (Step 8)
- Modify: `packages/webrun-streams-{peerjs,livekit}/README.md` (their params tables gain `mux`)

**Interfaces:**
- Consumes: `emulateMux`'s credit wiring from Task 3 — in particular 3e's
  `reserve` loop and 3h's grant `ACK`. Not executable before Task 3.
- Produces: `MakePair` becomes `(tuning?: PairTuning) => Promise<ConnectServePair>`; `PairTuning` is exported. `ConnectWsParams`, `ServeWsParams`, `PortParams`, `ConnectPeerJsParams`, `ServePeerJsParams` and `LiveKitParams` each gain `mux?: EmulateMuxOptions`.

An existing `() => Promise<ConnectServePair>` factory is assignable to the new
`MakePair` — TypeScript allows a function that ignores parameters — so every
adapter that does not forward the tuning keeps compiling unchanged.

- [ ] **Step 1: Widen `MakePair`**

In `packages/webrun-streams-conformance/src/loopback.ts`, replace the
`MakePair` type:

```ts
/**
 * Flow-control tuning L6 asks a pair for. An adapter that can pass these
 * through to its `emulateMux` should; one that multiplexes natively, or has
 * no configurable window, ignores them and L6 degrades to an integrity check.
 */
export interface PairTuning {
  mtu?: number;
  maxStreamBuffer?: number;
}

export type MakePair = (tuning?: PairTuning) => Promise<ConnectServePair>;
```

and export it from `src/index.ts`:

```ts
export {
  type ConnectServePair,
  type MakePair,
  makeLoopbackPair,
  type PairTuning,
} from "./loopback.js";
```

`makeLoopbackPair` ignores the argument, deliberately: the loopback has no
transport and therefore no flow control, and L6 must pass against it. That is
the suite's own self-test.

- [ ] **Step 2: Write the failing level**

In `packages/webrun-streams-conformance/src/describe-duplex-adapter.ts`, add
after the `describe("L5: transport teardown", …)` block (which ends with the
`pair close after operation completes without throwing` test):

```ts
    describe("L6: flow control", () => {
      it("delivers a body many times the advertised window to a slow consumer", async () => {
        // A 16 KiB window against a 256 KiB body: the sender must exhaust its
        // credit and wait for grants sixteen times over. An adapter that
        // ignores the tuning runs this at its own defaults, where it degrades
        // to an integrity check — that is stated in the README, not hidden.
        const pair = await makePair({ mtu: 4096, maxStreamBuffer: 16 * 1024 });
        try {
          await pair.serve(echoHandler);
          const size = 256 * 1024;
          const body = new Uint8Array(size);
          for (let i = 0; i < size; i++) body[i] = i & 0xff;

          const { call, close } = await pair.connect();
          const out = call([body]);
          let received = 0;
          let first = -1;
          let last = -1;
          for await (const chunk of out) {
            if (chunk.byteLength === 0) continue;
            if (first < 0) first = chunk[0] as number;
            last = chunk[chunk.byteLength - 1] as number;
            received += chunk.byteLength;
            // Drain deliberately slowly, so the sender is stalled on credit
            // for most of the transfer rather than streaming through.
            await delay(1);
          }

          expect(received).toBe(size);
          expect(first).toBe(0);
          expect(last).toBe((size - 1) & 0xff);
          await close();
        } finally {
          await pair.close();
        }
      });
    });
```

Also fix the file's own doc comment (line 13), which says `L0–L5`:

```ts
 * Runs every conformance level (L0–L6) against the supplied `ConnectServePair`
```

- [ ] **Step 3: Thread the tuning through the conformance suite's own pair**

In `packages/webrun-streams-conformance/tests/emulate-mux.test.ts`:

```ts
const makePair: MakePair = async (tuning) => {
  const { a, b } = makePipePair();
  const client = emulateMux(a, { side: "initiator", ...tuning });
  const server = emulateMux(b, { side: "responder", ...tuning });
```

- [ ] **Step 4: Run and confirm L6 is real, not decorative**

```bash
pnpm --filter @statewalker/webrun-streams-conformance test
```

Expected: PASS, 22 tests (20 before, plus L6 on the loopback pair and on the
`emulateMux` pair).

Then prove it can fail, one mutation at a time in
`packages/webrun-streams/src/emulate-mux.ts`, reverting after each:

| mutation | expected |
| --- | --- |
| delete the `sendFrame(id, TYPE_ACK, encodeUint32(grant))` line (Task 3, 3h) | 2 failed — L6 and L0's 10 MiB case, both by 5 s timeout |
| replace `await s.outboundCredit.reserve(…)` with `Math.min(mtu, chunk.byteLength - off)` (no flow control at all) | 1 failed — L6, immediately: the sender floods 256 KiB into a 16 KiB window and the receiver's cap tears the stream down |

That is the property the previous draft's L6 did not have: it passed with credit
removed entirely, while its README entry and commit message claimed it proved
stalling and replenishment.

- [ ] **Step 5: Add `mux` to the four adapters that construct `emulateMux`**

`-webrtc` and `-libp2p` are **not** in this list; they never call `emulateMux`.

**5a. `packages/webrun-streams-port/src/connect-serve.ts`** — import the option
type, add the field, spread it:

```ts
import {
  type Connect,
  type Duplex,
  emulateMux,
  type EmulateMuxOptions,
  type Serve,
} from "@statewalker/webrun-streams";
```

```ts
  /**
   * Flow-control tuning forwarded to `emulateMux` — `mtu` and
   * `maxStreamBuffer`, which is the credit this side advertises. `side` here
   * wins over `mux.side`. Defaults are `emulateMux`'s own; the conformance
   * suite's L6 uses this to run at a window small enough that a sender
   * genuinely stalls.
   */
  mux?: EmulateMuxOptions;
```

```ts
export const connect: Connect<PortParams> = async ({ port, side, mux: muxOpts }) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { ...muxOpts, side: side ?? muxOpts?.side ?? "initiator" });
```

```ts
export const serve: Serve<PortParams> = async ({ port, side, mux: muxOpts }, handler: Duplex) => {
  const channel = byteChannelFromMessagePort(port);
  const mux = emulateMux(channel, { ...muxOpts, side: side ?? muxOpts?.side ?? "responder" });
```

**5b. `packages/webrun-streams-ws/src/connect.ts`** — add `mux?: EmulateMuxOptions`
to `ConnectWsParams` with the same doc comment, extend the import, and change
line 35 to `emulateMux(channel, { ...params.mux, side: "initiator" })`.

**5c. `packages/webrun-streams-ws/src/serve.ts`** — add `mux?: EmulateMuxOptions`
to `ServeWsParams`, extend the import, and change line 26 to
`emulateMux(channel, { ...params.mux, side: "responder" })`.

**5d. `packages/webrun-streams-peerjs/src/connect-serve.ts`** — add the field to
both `ConnectPeerJsParams` and `ServePeerJsParams`, and spread it at lines 17
and 32. The `serve` side destructures `{ peer }`; take `mux` alongside it.

**5e. `packages/webrun-streams-livekit/src/connect-serve.ts`** — add the field to
`LiveKitParams` (one type serves both directions) and spread it at lines 14 and 25.

In every case `side` is set *after* the spread, so a caller cannot override the
adapter's id-allocation side by passing `mux.side`. That is deliberate: two
peers on the same side collide on stream ids.

- [ ] **Step 6: Forward the tuning from the `-ws` and `-port` pair factories**

In `packages/webrun-streams-port/tests/conformance.test.ts`:

```ts
const makePortPair: MakePair = async (mux) => {
  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();
  return {
    connect: () => connect({ port: channel.port1, side: "initiator", mux }),
    serve: (handler) => serve({ port: channel.port2, side: "responder", mux }, handler),
```

In `packages/webrun-streams-ws/tests/make-ws-pair.ts`, take the tuning as the
factory's parameter (`export const makeWsPair: MakePair = async (mux) => {`) and
pass `mux` into both the `connect({ url, WebSocketCtor, mux })` call and the
`serve({ onConnection, mux }, handler)` call.

The `-peerjs` and `-livekit` pair factories do not exist yet (see "What this
plan does not do"), so there is nothing to forward there.

- [ ] **Step 7: Run every suite this touched**

```bash
pnpm --filter @statewalker/webrun-streams-conformance test
pnpm --filter @statewalker/webrun-streams-ws test
pnpm --filter @statewalker/webrun-streams-port test
pnpm --filter @statewalker/webrun-streams-peerjs test
pnpm --filter @statewalker/webrun-streams-livekit test
pnpm --filter @statewalker/webrun-streams-webrtc test
pnpm --filter @statewalker/webrun-streams-libp2p test
```

Expected: 22, 11, 35, 1 skipped, 1 skipped, 1 skipped, 6 passed + 1 skipped.
`-ws` gains L6 (10 → 11); `-port` gains L6 (34 → 35). The three browser-gated
packages report a single skipped placeholder in Node, unchanged. `-libp2p`
without `WEBRUN_STREAMS_LIBP2P=1` does not register the conformance suite, so
its count is unchanged.

Then confirm `-port`'s L6 is real coverage and not just an integrity check:
re-apply the "delete the grant line" mutation and expect
`pnpm --filter @statewalker/webrun-streams-port test` to fail on L6 and on L0's
10 MiB case. Revert.

- [ ] **Step 8: Update the documentation, all seven places**

The measured set is **seven**, not six. Task 3 changed none of them; this step
changes all of them, because a half-updated set is worse than an un-updated one.
Item 1 below is an *addition* (a new L6 bullet), so it is eight edits over seven
stale sites. Confirm the set for yourself first:

```bash
grep -rn "L0–L5\|six levels" --include="*.md" --include="*.ts" . \
  | grep -v node_modules | grep -v docs/superpowers
```

Measured on the tree this plan starts from, that prints exactly:

```
README.md:282                                              the suite asserts six levels
README.md:300                                              make L0–L5 pass
packages/webrun-streams-conformance/src/describe-duplex-adapter.ts:13
packages/webrun-streams-conformance/README.md:64
packages/webrun-streams-port/README.md:142
packages/webrun-streams-ws/README.md:152
docs/adr/0004-duplex-as-seam.md:66
```

`describe-duplex-adapter.ts:13` is handled by Step 2 above; the other six are
items 2–7 here. After this task the grep must return nothing.

1. `packages/webrun-streams-conformance/README.md`, after the L5 bullet:

```markdown
- **L6** Flow control — a 256 KiB body reaches a deliberately slow consumer intact through a 16 KiB advertised window, so the sender must exhaust its credit and resume on grants sixteen times over. Adapters that accept `mux` options can run it at that window; today that is `-ws` and `-port`, the only two with an executable conformance run. `-peerjs` and `-livekit` accept the option but have no pair helper yet, so L6 does not run for them. The loopback, `-webrtc` and `-libp2p` have no `emulateMux` to tune, so for them it is an end-to-end integrity check and nothing more.
```

2. The same file's API table (line 64): `Registers the whole L0–L5 suite for one adapter.` → `Registers the whole L0–L6 suite for one adapter.` Add a `PairTuning` row while you are there, and extend the `MakePair` row to `(tuning?: PairTuning) => Promise<ConnectServePair>`.

3. Root `README.md` line 282: "the suite asserts six levels" → "seven levels", and append flow control to the enumeration that follows: `…and idempotent teardown (L5), and flow control against a slow consumer at a small advertised window (L6)`.

4. Root `README.md` line 300: `| A new transport | \`webrun-streams-conformance\` — make L0–L5 pass |` → `L0–L6`.

5. `packages/webrun-streams-ws/README.md` line 152: `Passes every level (L0–L5) of` → `(L0–L6)`.

6. `packages/webrun-streams-port/README.md` line 142: same change.

7. `docs/adr/0004-duplex-as-seam.md` line 66 — "Both shipped fixes prove the
   value of the L0–L5 contract". This one is an **ADR**, and its Consequences
   section is a historical narrative, so **annotate rather than rewrite**: the
   sentence describes what was true when the ADR was accepted and that is not a
   defect. Append to it:

```markdown
   (The suite has since grown an L6 flow-control level, and the second of those two bugs was in the per-frame ACK path that ADR-0004's stop-and-wait design implied; receiver-advertised credit replaced that path, so `teardownStream` no longer holds an ACK resolver at all. See `docs/superpowers/specs/2026-09-04-webrun-rpc-design.md` Decision 8.)
```

   Keeping the original sentence and adding the correction is the point: an ADR
   that quietly edits its own history stops being a record.

While in the `-ws` and `-port` READMEs, add the new `mux` parameter to their
params tables — it is a public API addition and the house rule is that a README
documents the export surface in the same commit.

- [ ] **Step 9: Lint and commit**

```bash
pnpm --filter @statewalker/webrun-streams-conformance lint
pnpm --filter @statewalker/webrun-streams-ws lint
pnpm --filter @statewalker/webrun-streams-port lint
pnpm --filter @statewalker/webrun-streams-peerjs lint
pnpm --filter @statewalker/webrun-streams-livekit lint
git add packages/webrun-streams-conformance \
        packages/webrun-streams-ws \
        packages/webrun-streams-port \
        packages/webrun-streams-peerjs \
        packages/webrun-streams-livekit \
        README.md \
        docs/adr/0004-duplex-as-seam.md
git commit -m "test(conformance)!: L6 covers flow control at a small advertised window

MakePair takes optional { mtu, maxStreamBuffer }, and the four adapters that
construct emulateMux take a mux option to receive it. L6 pushes 256 KiB
through a 16 KiB window at a slow consumer, so the sender stalls and resumes
sixteen times; deleting the grant line or the reserve call turns it red.

-webrtc and -libp2p multiplex natively and never construct emulateMux, so
for them — and for the loopback reference — L6 is an integrity check on the
Duplex seam rather than coverage of the credit path.

BREAKING: MakePair gains an optional parameter (source-compatible), and four
adapter param types gain an optional mux field."
```

---

### Task 6: Move `MessageTarget` into `webrun-streams`

Shares no source file with Tasks 1–5, but depends on them for two stated
values: Step 7's test count assumes Tasks 1–3 have landed, and Step 10's README
anchor (`### Credit`) is created by Task 1 Step 8. Reorder it *after* Task 3, not
before. Spec Decision 7.

**Files:**
- Create: `packages/webrun-streams/src/message-target.ts`, `packages/webrun-streams/tests/message-target.test.ts`, `packages/webrun-streams/tsconfig.tests.json`
- Modify: `packages/webrun-streams/src/index.ts`, `packages/webrun-streams/package.json`
- Modify: `packages/webrun-http-browser/src/core/message-target.ts`

**Interfaces:**
- Produces: `MessageListener`, `MessageSource`, `MessageSink`, `MessageTarget` exported from `@statewalker/webrun-streams`. `webrun-http-browser` re-exports them from its existing path, so its five internal importers are untouched.

**On the red phase.** These are *types*. A type-only import is erased before the
file runs, so a runtime test cannot observe whether the module exists — write
one and it passes green before you create anything. And nothing in this package
typechecks `tests/`: `tsconfig.json` is `"include": ["src"]`, and the root
`vitest.config.ts` sets no `test.typecheck`. So the red phase has to be a
typecheck, and this task creates the config that makes one possible. The pattern
is copied from `webrun-http-streams`, which already has `tsconfig.tests.json`
and a `typecheck:tests` script.

- [ ] **Step 1: Add a typecheck config that sees `tests/`**

Create `packages/webrun-streams/tsconfig.tests.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    // The build config roots at `src` to shape `dist`. This one only
    // typechecks, so it widens the root to take `tests` in as well.
    "rootDir": ".",
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["./src", "./tests"]
}
```

and add to `packages/webrun-streams/package.json` scripts, beside `typecheck`:

```json
    "typecheck:tests": "tsc -p tsconfig.tests.json",
```

- [ ] **Step 2: Establish the baseline before writing anything new**

```bash
pnpm --filter @statewalker/webrun-streams run typecheck:tests
```

Expected: **exit 1, two errors**, both pre-existing and both in
`tests/readme-examples.test.ts`:

```
tests/readme-examples.test.ts(162,42): error TS2741: Property '[Symbol.asyncIterator]' is missing in type '{ a: number; }[]' but required in type 'AsyncIterable<unknown>'.
tests/readme-examples.test.ts(168,41): error TS2741: Property '[Symbol.asyncIterator]' is missing in type '{ a: number; }[]' but required in type 'AsyncIterable<unknown>'.
```

Both are the same thing: `encodeJsonl<T>(input: AsyncIterable<T>)` is called
with an array. Nothing has ever typechecked this directory, so they have been
invisible. **Leave them.** Widening `encodeJsonl` to accept `Iterable` is a
public-API change to an unrelated codec and does not belong in a flow-control
plan; record it as a follow-up. This is the baseline every later run in this
task is compared against — the same technique Task 8 Step 4 uses for lint.

- [ ] **Step 3: Write the failing test**

Create `packages/webrun-streams/tests/message-target.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MessageTarget } from "../src/index.js";

describe("MessageTarget", () => {
  it("is satisfied structurally by a MessagePort", () => {
    const { port1 } = new MessageChannel();
    const target: MessageTarget = port1;
    expect(typeof target.postMessage).toBe("function");
    expect(typeof target.addEventListener).toBe("function");
    port1.close();
  });

  it("is satisfied by a minimal hand-rolled object", () => {
    const target: MessageTarget = {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
    };
    expect(typeof target.postMessage).toBe("function");
  });
});
```

The two runtime assertions are there to give vitest something to run and to
catch a `MessagePort` that stops exposing these methods. They are **not** the
test: `const target: MessageTarget = port1` is, and it is checked by Step 4, not
by vitest.

- [ ] **Step 4: Run and watch it fail**

```bash
pnpm --filter @statewalker/webrun-streams run typecheck:tests
```

Expected: exit 1, **three** errors — the two from Step 2 plus:

```
tests/message-target.test.ts(2,15): error TS2305: Module '"../src/index.js"' has no exported member 'MessageTarget'.
```

The vitest run is deliberately not the red phase here:

```bash
pnpm --filter @statewalker/webrun-streams exec vitest run tests/message-target.test.ts
```

passes **2 tests** right now, with `MessageTarget` undefined everywhere, because
the import is erased. If you only ran vitest you would see green and conclude
the work was already done.

- [ ] **Step 5: Create the module**

Create `packages/webrun-streams/src/message-target.ts` with exactly the content
currently in `packages/webrun-http-browser/src/core/message-target.ts`:

```ts
export type MessageListener = (event: MessageEvent) => void | Promise<void>;

/** An object we can listen for `"message"` events on. */
export interface MessageSource {
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  start?(): void | Promise<void>;
}

/** An object we can post messages to (with optional transferable list). */
export interface MessageSink {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** Full-duplex message target: both sends and receives. */
export interface MessageTarget extends MessageSource, MessageSink {
  close?(): void | Promise<void>;
}
```

- [ ] **Step 6: Export it**

In `packages/webrun-streams/src/index.ts`, add in alphabetical position (after `./map.js`):

```ts
export * from "./message-target.js";
```

- [ ] **Step 7: Run and verify green**

```bash
pnpm --filter @statewalker/webrun-streams run typecheck:tests
pnpm --filter @statewalker/webrun-streams test
```

Expected: typecheck back to exactly the two `readme-examples.test.ts` errors
from Step 2 and nothing else; **167** tests passing (163 after Task 3, 165 after
Task 4's two guard-regression tests, +2 here).

The absence of a diagnostic on `const target: MessageTarget = port1;` settles
the open question in spec Decision 7 — "`MessagePort` is expected to satisfy
`MessageTarget` structurally … To be confirmed when typing it; if the DOM
overloads do not line up, a thin `messageTargetFromMessagePort` is added". They
line up. No adapter is needed. Say so in the commit message so the follow-up is
not carried forward as still-open.

- [ ] **Step 8: Turn the http-browser copy into a re-export**

Replace the entire contents of `packages/webrun-http-browser/src/core/message-target.ts` with:

```ts
// Moved to @statewalker/webrun-streams so webrun-rpc and webrun-streams-port
// can use these without depending on this package. Re-exported here so the
// five internal importers, and this package's public API, are unchanged.
export type {
  MessageListener,
  MessageSink,
  MessageSource,
  MessageTarget,
} from "@statewalker/webrun-streams";
```

- [ ] **Step 9: Build `webrun-streams` before building http-browser**

```bash
pnpm --filter @statewalker/webrun-streams run build
pnpm --filter @statewalker/webrun-http-browser test
pnpm --filter @statewalker/webrun-http-browser run build
```

The first command is not optional and is not tidiness. `pnpm --filter X run
build` does **not** build X's workspace dependencies, and
`packages/webrun-http-browser/tsconfig.json` *overrides* `compilerOptions.paths`
with `{"@/*": ["./*"]}` — `paths` is replaced, not merged, so the base config's
`@statewalker/*` → `src` mapping does not apply there. `tsc` resolves
`@statewalker/webrun-streams` through `node_modules` to
`packages/webrun-streams/dist/index.d.ts`, which is stale until you rebuild it,
and fails with `TS2305: Module '"@statewalker/webrun-streams"' has no exported
member` once for each re-exported name — `MessageListener`, `MessageSink`,
`MessageSource`, `MessageTarget`. Only vitest sidesteps this, via the alias
table in the root `vitest.config.ts` — which is why the `test` half would pass
while the `build` half failed.

Expected: all three green, 12 tests in http-browser.
`@statewalker/webrun-streams` is already a dependency of `webrun-http-browser`,
so no manifest change is needed — confirm with:

```bash
node -e 'console.log(Object.keys(require("./packages/webrun-http-browser/package.json").dependencies))'
```

- [ ] **Step 10: Update both READMEs**

In `packages/webrun-streams/README.md`, add to the `## Exports` section a group
after `### Credit`:

```markdown
### Message passing

| Export | Kind | Purpose |
| --- | --- | --- |
| `MessageTarget` | interface | Full-duplex structural view of a message endpoint — a `MessagePort`, a `Worker`, or a ServiceWorker bridge. Extends `MessageSource` and `MessageSink`. |
| `MessageSource` | interface | `addEventListener`/`removeEventListener` for `"message"`, plus optional `start()`. |
| `MessageSink` | interface | `postMessage(message, transfer?)`. |
| `MessageListener` | type | `(event: MessageEvent) => void \| Promise<void>`. |

These are types only — no runtime code — so `webrun-streams` keeps zero
dependencies. They live here rather than in `webrun-streams-port` so packages
that are not port-specific can use them without depending on that adapter.
A `MessagePort` satisfies `MessageTarget` structurally; no adapter is needed.
```

In `packages/webrun-http-browser/README.md`, the "Messaging primitives" table
row for `MessageTarget`/`MessageSource`/`MessageSink`/`MessageListener` (line
276) should note the move. Replace its Purpose cell with:

```markdown
The structural port view everything above accepts — a `MessagePort`, a `Worker`, or a SW bridge. Defined in [`@statewalker/webrun-streams`](../webrun-streams) and re-exported here.
```

- [ ] **Step 11: Lint and commit**

Use the package-scoped lints, not the root `pnpm lint`: the root script is
`biome check --write .` and exits 1 on a repo-wide baseline that has nothing to
do with this change (see Task 8 Step 4).

```bash
pnpm --filter @statewalker/webrun-streams lint
pnpm --filter @statewalker/webrun-http-browser lint
git add packages/webrun-streams/src/message-target.ts \
        packages/webrun-streams/tests/message-target.test.ts \
        packages/webrun-streams/tsconfig.tests.json \
        packages/webrun-streams/package.json \
        packages/webrun-streams/src/index.ts \
        packages/webrun-http-browser/src/core/message-target.ts \
        packages/webrun-streams/README.md \
        packages/webrun-http-browser/README.md
git commit -m "refactor(streams): move MessageTarget into the foundation

webrun-rpc and webrun-streams-port both need this seam, and having it in
webrun-http-browser would make them depend on the browser package.
Zero-runtime-code type module, so webrun-streams keeps zero dependencies.

Adds tsconfig.tests.json + typecheck:tests, because a type-only move has no
runtime red phase: nothing typechecked this package's tests, so the
assignability assertion it turns on was being compiled by nothing. Baseline
is two pre-existing TS2741s in readme-examples.test.ts (encodeJsonl takes an
AsyncIterable and the test passes an array) — left alone, tracked separately.

Confirms the open question in spec Decision 7: MessagePort satisfies
MessageTarget structurally, so no messageTargetFromMessagePort is needed.

webrun-http-browser re-exports from its old path; its five importers and
its public API are unchanged."
```

---

### Task 7: Release safety and the browser conformance configs

Two pieces of repository plumbing this change makes unsafe to leave alone. Both
were ratified as an extension to this plan's scope; neither is optional.

> **This task is already applied on this branch, except for Step 6.** Commits
> `b6d4683` and `4a0d180` landed the `.changeset/config.json` change, the
> `PUBLISHING.md` subsection, the three `vitest.browser.config.ts` files and
> their `devDependencies` before this plan was hardened. So Steps 1, 3 and 5
> below are stated as **what the committed state must be**, and Steps 2 and 4
> are the commands that confirm it: a `git add` of these paths stages nothing
> and `git commit` exits 1 with `nothing to commit, working tree clean`.
>
> The one piece that did **not** land is Step 6: the umbrella lockfile was never
> regenerated, so `@vitest/browser-playwright` is not linked into those three
> packages and their `test:browser` still cannot load its config. Step 6 is the
> only step in this task with work to do.
>
> If you are executing this plan on a tree that predates `b6d4683`, treat Steps
> 1, 3 and 5 as edits and Step 7 as a real commit; check with
> `git log --oneline | grep b6d4683`.

**Files:**
- Verify: `.changeset/config.json`, `PUBLISHING.md`
- Verify: `packages/webrun-streams-{webrtc,peerjs,livekit}/vitest.browser.config.ts` and those three packages' `package.json`
- Modify: the **umbrella's** `pnpm-lock.yaml`, via `pnpm install` (Step 6)

> **This is a configuration task, not a TDD cycle.** There is no behaviour to
> drive with a test; the checks are Steps 2, 4 and 6, and each is a command with
> a stated expected output.

- [ ] **Step 1: Stop a wire break shipping as a patch**

Eleven packages depend on `@statewalker/webrun-streams` via `workspace:*`, four
of them embedding `emulateMux`. If `.changeset/config.json` sets
`"updateInternalDependencies": "patch"`, a `minor` bump of `webrun-streams`
reaches `-ws`, `-port`, `-peerjs` and `-livekit` as `0.1.1 → 0.1.2` — inside
a `^0.1.1` range, a version semver tells consumers is always safe to take,
carrying an incompatible wire protocol. A client on `0.1.2` sends `OPEN` with a
4-byte payload to a `0.1.1` server that ignores it and never answers; the client
is granted nothing and stalls forever, with no error.

```diff
-  "updateInternalDependencies": "patch",
+  "updateInternalDependencies": "minor",
```

Already applied in `4a0d180`; Step 2 confirms it.

- [ ] **Step 2: Check it**

```bash
node -e 'const c=require("./.changeset/config.json");
console.log(c.updateInternalDependencies==="minor"?"OK":"WRONG: "+c.updateInternalDependencies)'
```

Expected: `OK`.

- [ ] **Step 3: Write down the 0.x rule the repository is actually following**

Already applied in `b6d4683` — `grep -c "0.x" PUBLISHING.md` prints **5** and
the subsection is at line 98. What follows is what that commit put there, kept
so the reasoning is auditable.

`PUBLISHING.md`'s Semver Guidelines say "**major**: Breaking changes to the API",
with no `0.x` carve-out. Task 8 Step 7 selects `minor` for a change the spec's
Consequences call breaking, twice. One of the two documents has to move, and it
is this one: every package here is pre-1.0, `^0.1.1` does not admit `0.2.0`, and
a `major` bump would assert a 1.0 stability commitment none of them is making.

Add a `updateInternalDependencies` row to the Configuration table with a
paragraph explaining Step 1's reasoning, and add a subsection after the Semver
Guidelines list:

```markdown
### On a `0.x` line, breaking changes are a **minor** bump

Every package here is pre-1.0. Semver gives `0.x` its own rule, and npm's
caret range implements it: `^0.1.1` allows `0.1.2` but **not** `0.2.0`. So on a
`0.x` line the minor position is what carries a break, and it is the position
consumers' ranges actually protect them against.

A `major` bump would assert 1.0 — a stability commitment none of these packages
is making yet. So:

- **`0.x` breaking change → `minor`** (`0.1.1` → `0.2.0`), with the break stated
  in the changeset summary and the commit marked `!` (e.g. `feat(streams)!:`).
- Read the **major** row above as applying once a package reaches `1.0.0`.

The `updateInternalDependencies: "minor"` setting above is the same rule applied
to dependents: it is what stops a `0.x` break from reaching them as a patch.
```

- [ ] **Step 4: Check it**

```bash
grep -c "0.x" PUBLISHING.md
```

Expected: a non-zero count. (There is nothing executable to assert here; the
check is that a reader following Task 8 Step 7 can find the rule it cites.)

- [ ] **Step 5: The three browser configs**

`-webrtc`, `-peerjs` and `-livekit` each have
`"test:browser": "vitest run --config vitest.browser.config.ts"`, and until
`b6d4683` **none of them had that file**. The command did not skip, gate or
degrade — it failed to load with `[UNRESOLVED_ENTRY] Cannot resolve entry module
vitest.browser.config.ts` and exited 1.

The file below is now present in all three packages, byte-identical to this
block (verified by `diff`). Confirm rather than create:

```bash
ls -l packages/webrun-streams-{webrtc,peerjs,livekit}/vitest.browser.config.ts
```

Expected: three files, 1840 bytes each.

```ts
// Browser-mode config for this package's `test:browser` script. It exists
// separately from the repo-root `vitest.config.ts` because `vitest run
// --config <file>` replaces the root config entirely rather than merging with
// it — so the workspace source aliases have to be restated here.
//
// Exported as a plain object, for the same reason the root config is: this
// file is loaded from a package directory whose `node_modules` does not
// necessarily resolve "vitest/config" for the loader. `defineConfig` is only
// a typing helper.
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";

// Resolve every `@statewalker/webrun-*` workspace import to its TypeScript
// source, mirroring the root `vitest.config.ts` and `tsconfig.base.json`'s
// `paths`. Without it the package `exports` maps send vitest to `dist/`, and
// the browser suite would silently test the last build rather than the tree.
const packagesUrl = new URL("../", import.meta.url);

const alias = readdirSync(fileURLToPath(packagesUrl)).flatMap((name) => {
  const srcUrl = new URL(`${name}/src/`, packagesUrl);
  if (!existsSync(new URL("index.ts", srcUrl))) return [];
  const specifier = `@statewalker/${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const srcDir = fileURLToPath(srcUrl);
  return [
    // Subpath first: the more specific pattern has to win.
    { find: new RegExp(`^${specifier}/(.+)$`), replacement: `${srcDir}$1.ts` },
    { find: new RegExp(`^${specifier}$`), replacement: `${srcDir}index.ts` },
  ];
});

export default {
  resolve: { alias },
  test: {
    include: ["tests/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
};
```

Each of the three packages' `devDependencies` already carries (alphabetically
sorted, as the rest of the block is):

```json
    "@vitest/browser-playwright": "^4.1.10",
    "playwright": "^1.62.1",
```

`@vitest/browser-playwright` must track vitest: its peer range is an **exact**
`vitest: 4.1.11`, and `^4.1.10` in the catalog resolves to `4.1.11` today. If
the catalog's vitest moves, this moves with it. The package depends on
`@vitest/browser`, so that is not listed separately.

- [ ] **Step 6: Link the devDependencies, then check how far the command gets**

**This is the only step in this task with work still to do.** The `package.json`
devDependencies were committed in `b6d4683`, but the **umbrella's** lockfile was
never regenerated, so its importer for these packages does not list them and
nothing is linked into their `node_modules`. Measured on this tree:

```
$ pnpm --filter @statewalker/webrun-streams-webrtc test:browser
failed to load config from .../packages/webrun-streams-webrtc/vitest.browser.config.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitest/browser-playwright'
  imported from .../packages/webrun-streams-webrtc/node_modules/.vite-temp/…
Exit status 1

$ sed -n '/^  workspaces\/webrun-wire\/packages\/webrun-streams-webrtc:/,/^$/p' <umbrella>/pnpm-lock.yaml
    devDependencies:
      '@roamhq/wrtc' … '@statewalker/webrun-streams-conformance' … '@types/node'
      … rimraf … rolldown … typescript … vitest
      # no @vitest/browser-playwright, no playwright
```

So the failure today is **not** the missing pair helper. It is
`ERR_MODULE_NOT_FOUND` at config load — the same *class* of failure `b6d4683`
was meant to remove, one layer down. Do not record `b6d4683` as having achieved
runnable browser conformance; it did not.

```bash
pnpm install                       # from the UMBRELLA root; see the note below
```

- [ ] **Step 6a: Verify the config now loads.** The check is the lockfile
  importer plus a load of the config itself, which is cheap and does not need a
  browser:

```bash
node -e 'const {readFileSync}=require("node:fs");
const s=readFileSync(process.env.UMBRELLA_LOCK,"utf8");
const m=s.match(/^  workspaces\/webrun-wire\/packages\/webrun-streams-webrtc:[\s\S]*?(?=\n  \S)/m);
console.log(/^\s+.@vitest\/browser-playwright.:/m.test(y) ? "OK: importer has the dep" : "MISSING: rerun pnpm install at the umbrella root")'
```

Expected: `OK: importer has the dep` (set `UMBRELLA_LOCK` to the umbrella's
`pnpm-lock.yaml`). Then:

```bash
pnpm --filter @statewalker/webrun-streams-webrtc exec playwright install chromium
pnpm --filter @statewalker/webrun-streams-webrtc test:browser
```

Expected: the config **loads** — both `[UNRESOLVED_ENTRY] Cannot resolve entry
module vitest.browser.config.ts` and `ERR_MODULE_NOT_FOUND` are gone — and the
run then fails somewhere later, on the missing pair helper. **This outcome is
unmeasured**: `pnpm install` at the umbrella root is a mutating, repo-wide
operation that the work producing this plan did not perform, and no browser was
available. Do not predict the message; record the one you get, and if the
failure is still at config load, say so rather than moving on.

What is verified, and is why this step cannot end green:
`tests/conformance.test.ts` in each of the three packages does
`void import("./make-webrtc-pair.js")` (respectively `./make-peerjs-pair.js`,
`./make-livekit-pair.js`) once it detects a browser, and **none of those three
files exists in the repository**. Compare `-ws`, which has
`tests/make-ws-pair.ts`, and `-libp2p`, which has `tests/make-libp2p-pair.ts`.
Writing them is a separate piece of work, out of scope here.

So after this task the state is: **three** blockers, two removed. Record exactly
that and do not claim the suites run.

Note on `pnpm install`: this repository's `pnpm-lock.yaml` is gitignored and the
authoritative lockfile is the umbrella's, because the cross-repo `workspace:*`
dependencies cannot resolve from here. Install from the umbrella root. That also
means the only file this task changes is a file **outside this repository**,
which is why Step 7 has nothing to commit here.

- [ ] **Step 7: Confirm there is nothing to commit here**

```bash
git add .changeset/config.json \
        PUBLISHING.md \
        packages/webrun-streams-webrtc/vitest.browser.config.ts \
        packages/webrun-streams-peerjs/vitest.browser.config.ts \
        packages/webrun-streams-livekit/vitest.browser.config.ts \
        packages/webrun-streams-webrtc/package.json \
        packages/webrun-streams-peerjs/package.json \
        packages/webrun-streams-livekit/package.json
git diff --cached --stat
```

Expected: **empty**. All of it is already in `b6d4683` and `4a0d180`; running
`git commit` here exits 1 with `nothing to commit, working tree clean`, so do
not run it. Task 7 contributes no commit of its own.

The one artefact this task produces — a regenerated umbrella `pnpm-lock.yaml` —
belongs to the umbrella repository, not this one. Commit it there, if the
umbrella's own rules call for it.

For reference, this is the message `b6d4683`/`4a0d180` carried, and what it
should have said about the lockfile:

```
chore: release safety for a 0.x wire break, and the missing browser configs

updateInternalDependencies patch -> minor. Eleven packages depend on
webrun-streams; under 'patch' the four that embed emulateMux would ship an
incompatible wire protocol as a patch release, inside a ^0.1.1 range.
PUBLISHING.md now states the 0.x rule its own semver table contradicted.

vitest.browser.config.ts existed in none of -webrtc, -peerjs or -livekit,
so their test:browser scripts failed to load a config rather than running a
gated suite. The configs are here now.

They still cannot run: the devDependencies these configs import are not in
the umbrella lockfile's importer for these packages, so test:browser fails
at config load with ERR_MODULE_NOT_FOUND until pnpm install is run at the
umbrella root. And even then all three conformance files import a
make-*-pair helper (make-webrtc-pair.ts, make-peerjs-pair.ts,
make-livekit-pair.ts) that does not exist in this repository. Both are
separate work.
```

---

### Task 8: Full verification sweep

**Files:** none modified until Step 7.

- [ ] **Step 1: Clean build of every package**

```bash
rm -rf packages/*/dist
pnpm -r run build
```

Expected: exit 0, and all **15** `packages/*` emitting both `dist/index.js` and
`dist/index.d.ts`. The workspace glob also covers `apps/*` — five demo packages
that build Vite page bundles into `dist/client-page/…` and never emit an
`index.js`; the `rm -rf packages/*/dist` above does not clean them either. Check
the 15, not "every package":

```bash
ls packages/*/dist/index.js | wc -l    # expect 15
ls packages/*/dist/index.d.ts | wc -l  # expect 15
```

- [ ] **Step 2: Full test suite**

```bash
pnpm -r run test
```

Expected: no failures. The baseline before this plan was **643 passing** and
**five** skipped. This plan adds, per package:

| package | before | after | added by |
| --- | --- | --- | --- |
| `webrun-streams` | 131 | 167 | Task 1 (+13), Task 2 (+7), Task 3 (+12), Task 4 (+2), Task 6 (+2) |
| `webrun-streams-conformance` | 20 | 22 | Task 5, L6 on two pairs |
| `webrun-streams-ws` | 10 | 11 | Task 5, L6 |
| `webrun-streams-port` | 34 | 35 | Task 5, L6 |

so **679 passing** (`643 + 32 + 2 + 1 + 1`). If your number differs, reconcile
it against this table before continuing rather than assuming drift.

The skip set must not grow. It is **five**, not four: one browser gate each in
`-webrtc`, `-peerjs` and `-livekit`, one vendor gate in `-libp2p` (6 passed |
1 skipped of 7), and one in `apps/site-builder-jspm-demo` (18 passed | 1 skipped
of 19).

- [ ] **Step 3: Confirm the zero-dependency invariant held**

```bash
node -e 'const p=require("./packages/webrun-streams/package.json");
const d={...p.dependencies,...p.peerDependencies};
console.log(Object.keys(d).length===0?"OK: zero runtime deps":"REGRESSION: "+Object.keys(d))'
```

Expected: `OK: zero runtime deps`.

- [ ] **Step 4: Lint**

```bash
pnpm lint:check
```

**This command exits 1 today and will still exit 1 after this plan.** Do not
read that as a failure; compare against the baseline.

**Read the whole baseline before comparing.** `biome check` prints at most
**20** diagnostics by default and says nothing about the rest, and the true
baseline is **30**. Two earlier attempts to record this table compared truncated
lists and disagreed with each other for that reason alone. Run it with the limit
raised:

```bash
npx biome check --max-diagnostics=200 .
```

Measured on the tree this plan starts from: `Found 19 errors. Found 9 warnings.
Found 2 infos.`, over exactly these 30 diagnostics:

| file | diagnostics |
| --- | --- |
| `biome.json` | `2:14` deserialize, `18:13` deserialize (deprecated), `10:24` `lint/suspicious/useBiomeIgnoreFolder` |
| `apps/livekit-demo/client-page/index.html` | `36:7`, `40:7`, `44:7` `lint/a11y/noLabelWithoutControl` |
| `apps/livekit-demo/server-page/index.html` | `31:7`, `35:7`, `39:7` `lint/a11y/noLabelWithoutControl` |
| `apps/p2p-demo/e2e/browser-to-browser.mjs` | `210:7` `lint/complexity/useOptionalChain` |
| `apps/p2p-demo/lib/join-group.ts` | `1:1` `assist/source/organizeImports`, `5:8` `lint/style/useImportType`, `92:11` `lint/suspicious/noImplicitAnyLet` |
| `packages/webrun-http-streams/src/http1/encode.ts` | `53:24` and `63:21` `lint/style/noNonNullAssertion` |
| `packages/webrun-http-streams/src/http1/headers.ts` | `202:15` `lint/style/noNonNullAssertion` |
| `packages/webrun-streams-libp2p/src/duplex-over-stream.ts` | `272:20` and `344:15` `lint/style/noNonNullAssertion` |
| `packages/webrun-streams/src/emulate-mux.ts` | `522:15` `lint/style/noNonNullAssertion` — **moves to `552:15` once Task 3 lands**, and is the only baseline entry this plan touches |
| formatting (11 files) | `turbo.json`, `apps/livekit-demo/lib/config.ts`, `apps/p2p-demo/tests/discovery.test.ts`, `packages/webrun-http-streams/tests/{fetch-null-body,http1-node-interop,http1-strict,http-stubs-drain}.test.ts`, `packages/webrun-streams-libp2p/tests/stream-limits.test.ts`, `packages/webrun-streams-signaling/src/qr-signaling.ts`, `packages/webrun-streams-signaling/tests/mocks/{rtc,signaling-bus}.ts` |

Any diagnostic outside that set is yours.

Note the last two rows against what earlier drafts of this step claimed. The
`decodeVarint` warning **is** in the root output — a previous draft said it was
not, on a truncated run — and the formatting set is eleven files, not four.

Separately, the **package-scoped** lint used throughout this plan does exit 0,
and that is the one to trust for the packages you edited:

```bash
pnpm --filter @statewalker/webrun-streams lint
```

It reports exactly one pre-existing warning — `lint/style/noNonNullAssertion`
inside `decodeVarint` in `src/emulate-mux.ts`, at `:552` after Task 3, untouched
by this plan — and exits 0. A *second* diagnostic in that file is yours.

- [ ] **Step 4a: Typecheck the tests, against their known baseline**

Task 6's `typecheck:tests` is the **only** thing that checks the one assertion
Task 6 exists to make — `const target: MessageTarget = port1`. vitest cannot see
it, because a type-only import is erased before the file runs. Without this step
that script is invoked three times inside Task 6 and never again: it is not a
task in `turbo.json` (which has `build`, `test`, `lint`), there is no root
`typecheck` script, and nothing else in this sweep runs `tsc` over `tests/`.
Measured consequence of the gap: adding one required member to `MessageSink`, so
a `MessagePort` no longer satisfies `MessageTarget`, leaves `pnpm -r run test`
green and `typecheck` at exit 0.

`typecheck:tests` itself exits 1 on a two-error baseline (Task 6 Step 2), so it
cannot be used bare as a gate — a third error would be indistinguishable from
the baseline to any script. Compare against the baseline instead:

```bash
pnpm --filter @statewalker/webrun-streams run typecheck:tests 2>&1 \
  | grep 'error TS' \
  | grep -v 'readme-examples\.test\.ts(162,42): error TS2741' \
  | grep -v 'readme-examples\.test\.ts(168,41): error TS2741' > /tmp/typecheck-extra.txt
if [ -s /tmp/typecheck-extra.txt ]; then
  echo "REGRESSION: typecheck:tests reports errors outside the known baseline:"
  cat /tmp/typecheck-extra.txt
  exit 1
fi
echo "OK: typecheck:tests is at its two-error baseline"
```

Expected: `OK: typecheck:tests is at its two-error baseline`.

Measured, both directions. With the tree as this plan leaves it, the block
prints `OK` and exits 0. With `readonly __mustNotExist: true;` added to
`MessageSink` — exactly the class of change Task 6's assertion exists to catch:

```
REGRESSION: typecheck:tests reports errors outside the known baseline:
tests/message-target.test.ts(7,11): error TS2741: Property '__mustNotExist' is missing in type 'MessagePort' but required in type 'MessageTarget'.
tests/message-target.test.ts(14,11): error TS2741: Property '__mustNotExist' is missing in type '{ postMessage(): void; addEventListener(): void; removeEventListener(): void; }' but required in type 'MessageTarget'.
```

exit 1. Reverting the member returns it to `OK`.

If the two `readme-examples.test.ts` errors are ever fixed — the one-line
`AsyncIterable` → `Iterable` widening this plan defers — delete the two `grep -v`
lines and the script becomes a plain `exit 0` gate that can move into
`turbo.json`.

- [ ] **Step 5: Verify the READMEs match the code**

Every public export must appear in its package's README, which is the standard
these READMEs were brought to. This resolves each `index.ts`'s re-export chain
and reports anything undocumented:

```bash
node -e '
const fs=require("node:fs"),path=require("node:path");
const readIf=p=>fs.existsSync(p)?fs.readFileSync(p,"utf8"):null;
const resolve=(spec,from)=>{const b=path.resolve(path.dirname(from),spec.replace(/\.js$/,""));
  for(const c of [b+".ts",path.join(b,"index.ts")]) if(fs.existsSync(c)) return c; return null;};
const surface=(f,seen=new Set())=>{if(!f||seen.has(f))return[];seen.add(f);
  const src=readIf(f);if(!src)return[];const out=[];
  for(const m of src.matchAll(/^export\s+\*\s+from\s+["\x27]([^"\x27]+)["\x27]/gm)) out.push(...surface(resolve(m[1],f),seen));
  for(const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for(const part of m[1].split(",")){
    const t=part.trim().replace(/^type\s+/,"").split(/\s+as\s+/).pop().trim(); if(t) out.push(t);}
  for(const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/gm)) out.push(m[1]);
  return out;};
let bad=0;
for(const pkg of fs.readdirSync("packages").sort()){
  const idx=`packages/${pkg}/src/index.ts`; if(!fs.existsSync(idx)) continue;
  const syms=[...new Set(surface(idx))];
  const rd=readIf(`packages/${pkg}/README.md`)??"";
  const missing=syms.filter(x=>!new RegExp("\\b"+x.replace(/\$/g,"\\$")+"\\b").test(rd));
  if(missing.length){bad++;console.log(pkg,"UNDOCUMENTED:",missing.join(" "));}
}
console.log(bad===0?"OK: every public export is documented":"REGRESSION: "+bad+" package(s)");
'
```

Expected: `OK: every public export is documented`. If anything is listed, the
task that added it skipped its documentation step — go back and fix that
commit's README rather than patching it here.

Note there is no `__testing` filter in this script any more. Task 2 put the
uint32 codec in a module the barrel does not re-export, so there is no
publicly-reachable symbol needing to be excused.

- [ ] **Step 6: Confirm the umbrella needs no change**

This plan creates no package and renames no repository, so the umbrella's
registry and durable documents are untouched. This repository is usually
checked out as `<umbrella>/worktrees/<name>/workspaces/webrun-wire`, in which
case the umbrella toplevel is three levels up — but it can also be a plain
clone, where that path is a different repository or none at all. So resolve it
rather than assuming:

```bash
UMBRELLA=$(git -C ../../.. rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$UMBRELLA" ] && [ -f "$UMBRELLA/repos.json" ]; then
  git -C "$UMBRELLA" status --porcelain
else
  echo "not an umbrella assembly — nothing to check"
fi
```

Expected: empty output, or the "not an umbrella assembly" line. If `repos.json`
or `docs/multirepo/MODEL.md` shows as modified, something in this plan exceeded
its scope — stop and review.

- [ ] **Step 7: Add a changeset**

```bash
pnpm changeset
```

Select, and justify each against the rule Task 7 Step 3 added to
`PUBLISHING.md`:

| package | bump | why |
| --- | --- | --- |
| `@statewalker/webrun-streams` | minor | Breaking wire format on a `0.x` line, plus new exports. `0.1.1 → 0.2.0`. |
| `@statewalker/webrun-streams-port` | minor | `PortParams` gains `mux`; embeds the new wire format. |
| `@statewalker/webrun-streams-conformance` | minor | `MakePair` gains a parameter; L6 is new. |
| `@statewalker/webrun-streams-ws` | minor | `ConnectWsParams`/`ServeWsParams` gain `mux`; embeds the new wire format. |
| `@statewalker/webrun-streams-peerjs` | minor | params gain `mux`; embeds the new wire format. |
| `@statewalker/webrun-streams-livekit` | minor | params gain `mux`; embeds the new wire format. |
| `@statewalker/webrun-http-browser` | minor | Not "internal re-export only": `src/core/index.ts:4` is `export * from "@statewalker/webrun-streams"`, so Task 1 Step 6's four new exports (`newCreditLedger`, `CreditLedger`, `newCreditGrantor`, `CreditGrantor`) plus Task 6's four `MessageTarget` types become public exports **of this package too**. `PUBLISHING.md` calls new features minor. It would take a minor anyway: `updateInternalDependencies: "minor"` (Task 7 Step 1) bumps it as a dependent of `webrun-streams`, so an explicit `patch` here would be silently overridden and would mislead anyone reading the table. |

Name the four `emulateMux`-embedding adapters **explicitly** rather than letting
changesets bump them as dependents: a dependent bump produces an "Updated
dependencies" changelog line with no mention of a protocol break, and the whole
point of Task 7 Step 1 is that a consumer must be able to see one. `-webrtc` and
`-libp2p` multiplex natively, are unaffected, and take the automatic dependent
bump.

State the wire-format break explicitly in the summary, and note that `emulateMux`
now costs one round trip per stream at open.

`webrun-streams`' minor also covers two smaller surface changes worth naming in
the summary: `emulateMux` now **throws** `RangeError` for `maxStreamBuffer < 1`
where it previously accepted it, and a window above `2^32 - 1` is advertised as
`2^32 - 1` rather than wrapping.

- [ ] **Step 8: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for credit-based flow control

Wire format changed: OPEN and ACK carry uint32 credit payloads. Peers
predating this cannot interoperate, so every package embedding emulateMux is
named explicitly at minor rather than taking a dependent patch.

The RPC tier (webrun-streams-port's send/recieve) is unchanged here: it is
credited in Plan 2, when it moves to webrun-rpc."
```
