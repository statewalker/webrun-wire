# Plan B2 (the stream tier) — findings

What executing Plan B2 taught, written while the evidence was still to hand. The plan is
`docs/superpowers/plans/2026-09-06-port-mux-layer-2b-streams.md`; the design is
`docs/superpowers/specs/2026-09-05-port-multiplexer-design.md`, which is the binding authority and
was checked against the code for every claim below. Its two predecessors are
`2026-09-05-port-mux-layer-1-findings.md` (Plan A) and `2026-09-05-port-mux-layer-2a-findings.md`
(Plan B1).

**What B2 did.** `callPort` gained `NO_TIMEOUT`. `duplexOverPort` / `serveDuplexOverPort` run one
`Duplex` over one port, one `callPort` per chunk on each direction's own channel, with the reply as
the confirmation. The stream carries an inactivity timeout, defaulting to none. A second
unconfirmed chunk closes the offending port. `transferPortMux` is a second `PortMux` whose ports are
real transferred `MessagePort`s. And the **unmodified** L0–L6 conformance suite now runs a *second*
time, against the new stack.

**Range:** `d5ab4cc..ab1f377`, 14 commits.

**End state, measured rather than carried forward:**

| | before | after |
| --- | --- | --- |
| `webrun-rpc` | 75 tests / 13 files | **120 tests / 19 files** |
| repo-wide (`pnpm -r test`) | 721 passed / 5 skipped | **766 passed / 5 skipped** |

The 5 skips are unchanged (`-webrtc`, `-peerjs`, `-livekit`, one libp2p case, one
`site-builder-jspm-demo` case — all environment-gated). `npx changeset status` exits 0.
`pnpm -r typecheck` fails only in `apps/site-builder-demo` and `apps/site-builder-jspm-demo`, which
is pre-existing: `webrun-site-{builder,host}/dist` do not exist in this worktree, neither app
references `webrun-rpc`, and no commit in this range touches `apps/` or `packages/webrun-site-*`.

Nothing was deleted. `emulateMux`, `connect`/`serve`, `byteChannelFromMessagePort` and the original
conformance run are all still present and green.

---

## The measured mutation table

Every mutation this plan ran, with what it *actually* killed beside what the plan *predicted*. Each
was applied by copying the file to a scratch path, editing in place, running, copying back and
confirming with `diff` — never `git checkout --` (Plan B1 finding 2).

| # | mutation | predicted | measured | verdict |
| --- | --- | --- | --- | --- |
| 1 | `call-port.ts`: force the finite-timeout guard to `if (true)` | 1 — "resolves a reply that arrives long after the 1000 ms default" | **1 deterministic + 1 flaky.** Implementer reported 2 deterministically; the reviewer re-ran 5×, measuring 1 kill in 3 runs and 2 in 2 runs | **discrepancy, in the report rather than the plan.** Cause: `setTimeout(fn, Infinity)` overflows Node's 32-bit timer field and clamps to ~1 ms rather than never firing (`TimeoutOverflowWarning`), so the second kill is a race between the `MessagePort` round trip and the clamped timer. The plan's prediction stands; the *first measurement of it* did not |
| 2 | `sendChunks`: drop `serializeError`, post the live `Error` | 1 — the custom-fields test | **2**, stable (implementer once, reviewer 3×) | **discrepancy — undercount.** Structural, not timing: `sendChunks` is the single sender for *both* directions and the suite has one error-propagation test per direction |
| 3 | `sendChunks`: delete the `maxMessageSize ? toChunks(…) : output` framing | 1 — the chunk-splitting test | **1** (`expected 1 to be 25`) | matches |
| 4 | `receiveChunks`: remove the installer's early-delivery `if (aborted)` branch | 1 — the early-abort test | **1**; re-reviewer reproduced independently twice | matches |
| 5 | gut `installAbortNotice.post()` | 2 | **3**, deterministic (implementer 5×, reviewer 2×) | **discrepancy — undercount.** The third, "a handler teardown wakes a caller that is still reading", calls the serve side's raw teardown; the caller learns of it only through the same notice. Strengthens Plan A finding 2 rather than weakening it |
| 6 | remove `teardownOnce`'s `if (torn) return;` | posed as a question, not a prediction | **kills nothing** — 91/91 green, whole package | **survives.** See below |
| 7 | gut the whole teardown to `off() {}` | — | kills the amended "notifies the peer exactly once" test | the amended test is non-vacuous for its own claim |
| 8 | make both `touch()` calls no-ops | 1 — "progress resets the clock" | **1**, twice | matches. The reviewer additionally mutated each `touch()` call site *individually*: each kills that same test alone, so neither site is dead code |
| 9 | `installStreamTimeout`: guard → `if (false)`, arm with `timeout ?? 0` | 1 — "no timeout by default" | **2**, stable (implementer 2×, reviewer 3×) | **discrepancy — undercount.** The F5 regression test also passes no `timeout`, so it is equally exposed; the mutation hits every caller relying on the default, not only the test that says so in its name |
| 10 | `installStreamTimeout` never arms | — | 2 — the stall test (via its rejection assertion) and the timer-leak test's floor | kills the stall test through the *old* assertion, not the new floor — which is why 11 was needed |
| 11 | arm the timer at `timeout × 10` | — | the stall test fails **on the new timing floor** (`expected 1503 to be less than 1000`), the rejection assertion still passing | the floor, not the rejection, is the discriminating check |
| 12 | remove `resolveEnded()` from `detach()` | — | exactly the new "stops pulling early" test, twice; the re-reviewer also killed both of its own probes with it | matches |
| 13 | `receiveChunks`: `if (outstanding)` → `if (false)`, against the **as-written** hostile suite | 1, with an explicit question about test 3 | **1** of 4, 5/5 runs. Test 3 survived | **discrepancy — overcount.** Test 3 never inspects the offending port, so it passes with enforcement wholly disabled. This is how its vacuity was found |
| 14 | the same mutation against the **fixed** hostile suite | — | **4 of 6**, 5/5 runs | survivors are exactly the two deliberately orthogonal floors (a cooperative sender is never refused; garbage is ignored) |
| 15 | `setTimeout(…, 0)` before `port.close()` → close immediately | — | the re-reviewer's probe plus hostile tests 1 and 3 | the deferred close is load-bearing on a *virtual* port: it goes inert the instant it closes, so an immediate close eats the refusal |
| 16 | `transferPortMux`: delete `if (!accepted) { port.close(); return; }`, against the **as-written** suite | 1 — the rejection test | **0.** 6/6 in the file, 109/109 across the package, 3/3 runs | **discrepancy — overcount.** Tests 2 and 3 assert `expect(seen).toEqual([])` on the *client's* end of a channel nobody was ever going to send on. How their vacuity was found |
| 17 | the same mutation against the **fixed** suite | — | **2** — tests 2 and 3, with real assertion failures (`["should not arrive: port was rejected"]`; a `waitFor` timeout). Implementer 2×, re-reviewer 2× | the fix earns the claim in the tests' titles |
| 18 | `transferPortMux`: delete `if (!port) return;` | 1 — the "ignores traffic on the parent" test | **kills no assertion.** All 6 tests report passed; only the process exit code goes to 1 (implementer 3×, reviewer 2×) | **survives**, in the honest sense. See below |
| 19 | `transferPortMux.close()`: delete `removeEventListener` and the listener's `closed` guard | reviewer's own; originally left the suite green | after the test fix, kills test 5 (`expected 2 to be 1`), 2/2 | |
| 20 | conformance: a module-level `AbortController` in `runCallerSide` | — | **7 of 11**, including L1; L1 alone kills in 21 ms in isolation | proves the new conformance run is live and detects the per-module-vs-per-port defect class |
| 21 | conformance: `openPort` returns a cached port | — | L1 and L4 | |
| 22 | conformance: remove `notice.post()` | — | L3, and only L3 | |
| 23 | conformance: replace `deserializeError` with a bare `Error` | — | L4, and only L4 | |

### The pattern in the discrepancies

**Six of this plan's mutation predictions came out wrong** — rows 2, 5, 9, 13, 16 and 18 — and the
split is not what it first looks like. Three (2, 5, 9) *undercounted*: the mutation killed more than
predicted, in each case because a single shared mechanism serves more callers than the prediction
traced. Those are the harmless kind; they end with a stronger result than claimed. Three (13, 16, 18)
*overcounted*: the mutation killed **less** than predicted, and in two of them it killed nothing at
all. Every one of those three exposed a vacuous test.

Row 1 is a seventh discrepancy of a different kind: the plan was right and the first report of the
measurement was wrong, corrected only because a reviewer re-ran it five times instead of once.

The lesson, which is Plan A finding 1 restated in a new register: a mutation prediction is a
hypothesis about a *test suite*, not about a code path, and both halves can be wrong independently.
Run it, run it more than once, and report the number you get.

---

## Surviving mutations

Two, described in Plan A's register — "unreachable under any transport this package ships or
tests", never "dead code". Neither was upgraded into a kill by inventing a contrived test, and
neither guard was deleted.

### 1. `teardownOnce`'s `torn` early return (`src/duplex-over-port.ts`)

Removing `if (torn) return;` leaves the whole package green — all 91 tests at the time, in every
file, verified by the implementer over 5 runs and independently by the re-reviewer. The reason is
that every effect the teardown body performs a second time is *already independently idempotent*:
`AbortController.abort()` on an aborted controller is a spec no-op; `installAbortNotice`'s own
`posted` flag — not `torn` — is what suppresses re-notification, so the "notifies the peer exactly
once" assertion holds without it; `removeEventListener` on an unregistered listener is a no-op; and
`generator.return()` on a finished generator neither throws nor re-runs cleanup.

So the guard defends nothing observable through this package's public API today. It stays as defence
in depth against a future `notice`, `inbound` or `output` that is *not* independently idempotent.
The amended test around it is not vacuous for its own claim — a gutted `off() {}` turns it red
(row 7) — it simply does not discriminate on this one line.

### 2. `transferPortMux`'s `if (!port) return;` (`src/transfer-port-mux.ts`)

A `PORT_TRANSFER` message with no attached port is malformed. Deleting the guard makes the listener
throw `TypeError: Cannot read properties of undefined (reading 'start')` — but the throw happens
inside Node's own `MessagePort` dispatch, outside any `it()` body and outside every assertion's
reach. **Every individual test still reports passed.** Only the process exit code goes to 1, via
vitest's unhandled-exception detector (`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`), measured 3× by the
implementer and 2× by the reviewer.

So: the suite still exits non-zero and CI does go red — but nothing *covers* this line, and saying
otherwise would be a lie. Catching it inside an assertion would need a process-level
`uncaughtException` hook, which is not worth its own machinery for one guard. This is structurally
the same knowingly-uncovered shape Plan A recorded for `multiplexPort`'s `if (!handle) return;`.

Row 16's survivor is deliberately **not** on this list: it survived only against the as-written
tests, and after the fix round it kills two of them (row 17). It is a fixed vacuity, not a survivor.

---

## Where this plan was wrong

Four defects reached review **in the plan's own code** — code the briefs wrote out verbatim for
implementers to transcribe, not anything an implementer invented. Not one was caught by reading.
Every one was caught by a mutation or a probe.

### 1. An abort before the consumer's first pull hung the caller forever (Task 2)

`receiveChunks`'s `onAbort` delivered the abandonment through `void deliver?.(…)`. But `deliver` is
assigned inside `recieveIterator`'s installer, and `newAsyncGenerator` runs that installer *lazily*
— on the consumer's first `.next()`. A `STREAM_ABORT` arriving before the consumer starts iterating
therefore hit `deliver === undefined`, was a silent no-op, and consumed its `{ once: true }`
listener. When the consumer finally pulled, nothing was left to settle the generator.

It never settles. There is no backstop: Task 4's timeout defaults to none, on purpose. The reviewer
proved it with a probe (unsettled after 300 ms) rather than by argument.

Fixed in `257f862` by recording `aborted`/`abortReason` the instant the signal fires and having the
installer replay it if it is already set. Killed by row 4.

### 2. A vacuous `.not.toThrow()` idempotence test (Task 3)

"teardown is idempotent" asserted only that three `off()` calls did not throw. That is satisfied
unconditionally — even by `off() {}` — because every primitive underneath is independently
idempotent (see the survivor above). A ceiling with no floor.

Fixed in `42d1250` by giving it the peer-visible effect a caller actually depends on: exactly one
`STREAM_ABORT` reaches the peer across three teardowns. The same round answered the guard question
honestly rather than assuming: the `torn` guard is not load-bearing, and that is recorded as a
survivor instead of being papered over with a contrived test.

### 3. A vacuous `cleanupRan` assertion, satisfied by the fixture's own sleep (Task 4)

The stall test polled a `cleanupRan` flag inside a 6000 ms window. The reviewer instrumented both
worlds: with `{ timeout: 150 }` the rejection lands at 165 ms and `cleanupRan` flips at **5015 ms**;
with the timeout machinery removed **entirely** — `collectBytes` *resolving* instead of rejecting —
`cleanupRan` still flips at **5002 ms**. The flag was driven by the fixture's own `setTimeout(5000)`,
not by the abort, and no timing window separates the two worlds. The rejection assertion was
carrying the whole test.

Fixed in `1dfb184` by dropping `cleanupRan` altogether and asserting a timing floor on the rejection
itself (`< 1000 ms` against a ~5000 ms natural completion, a ~6.6× margin; measured 152/151/151 ms
across three runs). Row 11 proves the floor is the discriminating line.

An adjacent defect in the same feature was folded into the same fix: a serve-side stream completing
normally never reached `clock.stop()`, leaving the last `touch()`'s timer armed and the event loop
open. Fixing that opened a second hole — `ended` had a terminating path that never resolved, so a
handler that stopped pulling input early re-armed the leak through a different door — closed in
`298ce05` and pinned by row 12.

### 4. A poison branch that bypassed the abort machinery (Task 5)

D15's enforcement closed the offending port but set neither `aborted`/`abortReason` nor
`controller.abort()`. The reviewer proved two consequences:

- **The replay hole reopened.** Poison firing before the consumer's first `.next()` left the local
  stream pending forever, because the installer replays only `aborted` — the exact hole finding 1
  closed for aborts, reopened on a new path three tasks later.
- **The pump wedged.** `port.close()` makes an in-flight `NO_TIMEOUT` `callPort` unsettleable, and
  with nothing aborting the signal `sendChunks` never returns, the handler's `finally` never runs
  and the clock never disarms. A handler, a generator and a pending promise leak **per offending
  port** — which undercuts D15's own "bounds memory by construction" claim, using the very mechanism
  that was supposed to establish it.

Fixed in `c652dc7` by routing through `controller.abort(poison)`, which does all of it and made the
hand-rolled quartet redundant — strictly less code than the path it replaced.

### The pattern worth naming: five vacuous assertions, none found by reading

The four defects above are the plan's own; two of them are vacuous tests. Counting across the whole
plan, **five assertions turned out to be satisfied whether or not the machinery worked**, and all
five were in test code the briefs wrote out verbatim:

| where | assertion | why it was vacuous |
| --- | --- | --- |
| Task 3 | `expect(() => { off(); off(); off(); }).not.toThrow()` | every primitive underneath is independently idempotent |
| Task 4 | `waitFor(… () => cleanupRan, 6000)` | satisfied by the fixture's own 5 s sleep in both worlds |
| Task 5, test 3 | "the penalty is scoped to the offending port" | never inspected the offending port, only a survivor |
| Task 6, test 2 | "a rejected port is closed rather than silently kept" | `expect(seen).toEqual([])` on a channel nobody would ever send on |
| Task 6, test 3 | "with no `onPort` at all, an inbound port is rejected" | identical shape, identical reason |

**Not one was found by reading.** Each was found by running a mutation and noticing the number was
wrong — three of them by a mutation that killed *fewer* tests than predicted. This plan's
test-writing had a systematic blind spot for assertions that hold whether or not the mechanism
exists, and the only instrument that detected it was measurement. It is the third consecutive plan
in this project to hit the same shape (Plan A finding 5, Plan B1 section 1); what is new here is
that the "killed less than predicted" signal is *diagnostic* of it, and should be treated as a
finding rather than as a relief.

A related note on the same theme, from the reviewers' side: an all-green first run proves nothing.
Task 7's conformance run passed 11/11 on first contact, which is exactly when a suite is worth
least. Four independent kills (rows 20–23) were run before it was believed.

---

## What L6 is actually worth on this stack, with the number

Task 7's pair passes L6. It should not be cited as flow-control coverage in any form, and the
measurement says how hollow it is rather than hedging.

With a probe harness reproducing L6's exact configuration:

```
mux.maxMessageSize = undefined
serverChunks = 1    clientChunks = 1    bytes = 262144
```

**The suite's 256 KiB body crosses as exactly one chunk in each direction.** `sendChunks` skips
`toChunks` entirely when `maxMessageSize` is unset (`maxMessageSize ? toChunks(…) : output`), so
L6's slow-drain `await delay(1)` loop body runs **once**. Nothing stalls, nothing is replenished, no
chunk sequencing is exercised at all. The 3 ms runtime is the tell. The suite's own comment about
exhausting credit "sixteen times over" describes the `emulateMux` adapters, not this one.

So for this pair L6 is a single-chunk integrity check — weaker even than "an integrity check"
suggests. The first byte, the last byte and the total length are asserted, and that is the entire
content of its green. Verified independently by the reviewer.

The stack's real flow-control coverage lives in `tests/duplex-over-port-timeout.test.ts` (the F5
regression; that progress resets the clock) and `tests/duplex-over-port-hostile.test.ts` (a second
unconfirmed chunk is refused). D17's redefinition of L6 is Plan C's, deliberately: five adapters
still run L6 against `emulateMux`, where the credit window is real and the level does cover it.

---

## Two more things measured that a reader would otherwise be surprised by

**With an explicit `timeout`, a slow consumer *is* failed.** `touch()` fires only after
`await callPort` returns, and that reply is withheld until the consumer pulls past the value (D11).
The inactivity clock therefore cannot distinguish "the peer is slow" from "the peer is dead". This
is the placement the design specifies and the default is none, so F5 is genuinely fixed — but a
caller who sets a timeout should know what they are buying. Documented in the README rather than
left in the ledger.

**`transferPortMux`'s `issued` set never shrinks.** Every port it opens or accepts is retained until
`close()`; nothing removes one when it closes. Unlike `multiplexPort` there is no `maxPorts` for it
to exhaust, so nothing dies — a long-lived mux just accumulates dead `MessagePort` handles. It is
the plan's own code, deliberately deferred rather than fixed: bounding it needs a per-port
`close`-event listener, a newer platform surface the file otherwise avoids, plus its own tests.
Documented as a caveat with the practical advice (scope the mux to the lifetime of what it
multiplexes) and carried onto Plan C's list, because a deferred defect that nobody wrote down is
indistinguishable from one nobody noticed.

---

## Deferred minors, recorded so they are not rediscovered

- `await deliver?.(…)` discards `ChunkReceiver`'s `Promise<boolean>`; `false` means the chunk was
  *not* handled, yet `listenPort` still replies success — so the D11 confirmation can report
  "delivered" for a dropped chunk. Benign today.
- `duplexOverPort`'s returned `Duplex` can be invoked twice on one port; both invocations then
  cross-talk on the same two channel names. Documented, unenforced.
- The third `sendChunks` call site (the early-error `failing(err)` path) is threaded with `touch`
  correctly but is not exercised with a `timeout` set — correct by construction only.
- Once a serve handler stops pulling input, `detach()` calls `off()`, so the caller's remaining
  `NO_TIMEOUT` input calls are never answered; the caller unblocks only through its own `finally`
  abort. Worth an explicit test if half-close becomes a supported shape.
- A handler that never iterates its input leaves the eager `listenPort` handler parked in
  `await ready()` with no deadline of its own. Probed: no leak in practice, because the caller's
  `STREAM_ABORT` resolves `ended`. The serve side's only exit on that shape is the peer.
- After poison the serve side posts no `STREAM_ABORT` and `sendChunks` returns without a `done`
  chunk. The offender learns through `response:error` on `in`, but a peer parked on the `out` half
  has only layer 1's close, which is unobservable to layer 2. Reachable only by a hostile peer.
- A stream abort unwinds a producing handler via `iter.return()`, so the handler's `catch` never
  sees the abort reason — only `finally` runs. It cost a re-reviewer one wrong probe; now in the
  README.
- The conformance pair's per-connection `close()` is a no-op and `serveDuplexOverPort`'s teardown is
  discarded, so per-connection and serve-side per-stream teardown are unexercised by the new run.
  Both are the plan's own code; verified not load-bearing (a real `mux.close()` keeps all 11 green).

---

## For whoever writes Plan C

**Deleting `emulateMux` deletes more than `emulateMux`.** The full blast radius, verified against
the code rather than quoted from the spec:

- `packages/webrun-streams/src/emulate-mux.ts` itself.
- `connect` / `serve` (`packages/webrun-rpc/src/connect-serve.ts`) — the entire legacy byte-stream
  tier, and its `PortParams` / `side` / `mux` surface.
- `byteChannelFromMessagePort` (`packages/webrun-rpc/src/byte-channel.ts`), and `ByteChannel` as a
  public seam.
- `packages/webrun-streams/src/uint32.ts` and `packages/webrun-streams/tests/uint32.test.ts` — dead
  once `emulate-mux.ts` (their only consumer today) is gone. `flow-control.ts` is *not* on this
  list: it is D13's stated windowing mechanism and Plan C should consciously decide whether it
  follows windowing into `webrun-rpc`.
- **The 11 tests of the old conformance run** (`packages/webrun-rpc/tests/conformance.test.ts`,
  `webrun-rpc (MessageChannel pair)`). Plan B1's findings warned that deleting them would cost 11 of
  `webrun-rpc`'s tests; that debt is now **paid in advance** — `tests/conformance-new-stack.test.ts`
  runs the same unmodified 11 levels against `multiplexPort + duplexOverPort`. The new run replaces
  the old one; the package does not lose coverage when the old one goes.

**Still owed from the design:**

- **D17 — L6's redefinition and the `PairTuning` reshape.** L6 must pin the property D11 actually
  creates (the producer never runs more than one chunk ahead of the consumer), with a floor (the
  transfer completes) and a ceiling (never more than one ahead). `PairTuning` becomes
  `{ maxMessageSize? }` or empty. This is a breaking change to `webrun-streams-conformance`'s public
  API and touches every adapter's pair factory — which is exactly why it waits for the migration.
- **D14 — the shared control port.** Calls should share one control port (`{ kind: "control" }`)
  while streams get a port each (`{ kind: "stream" }`), so a one-shot call costs a request and a
  reply rather than `OPEN`/request/reply/`CLOSE`. Nothing in B2 implements the control half; the
  discriminator is passed through `meta` today and inspected by nobody.
- **`-ws` on the new stack.** The spec's Plan B ends with "`-port` and `-ws` on the new stack passing
  L0–L6". B2 delivered `-port` and not `-ws`, because `-ws` needs the adapter to expose a port
  factory — layer 3, which is Plan C's. Nothing here blocks it; Plan C gains one item.
- **`-peerjs`'s message ceiling is still unmeasured.** It must be measured *before* Plan C migrates
  it: `-peerjs` rides on WebRTC, and whatever chunking `emulateMux` is silently doing for it today
  disappears when `emulateMux` does.
- **`transferPortMux`'s `issued` set needs bounding** — a per-port `close`-event listener, plus its
  own tests. See above.

**One gap that is conformance-level only, stated precisely.** `mux.maxMessageSize` is `undefined` in
**both** conformance pairs, so `sendChunks`'s `toChunks` framing path is executed by **neither**
run. It is not uncovered: `tests/duplex-over-port.test.ts` has a dedicated chunking test with a real
floor (a 100 KiB body at a 4096-byte ceiling must arrive as 25 chunks and reassemble intact, and
row 3 kills it). The gap is that no *conformance* pair exercises framing — which matters when D17
reshapes `PairTuning` around `maxMessageSize`, because that reshape is the natural place to close
it.

**And two habits worth keeping:**

- Run every mutation more than once, and report the number measured rather than the number
  predicted. Row 1 exists because someone did, and rows 13/16/18 are where "fewer kills than
  predicted" turned out to mean "the test is vacuous", not "the guard is unimportant".
- Copy a file to a scratch path before mutating it and copy it back, verifying with `diff` or
  `md5sum`. Every probe in this plan did. `git checkout -- <path>` restores the last *committed*
  state and silently discards uncommitted work, file path or not (Plan B1 finding 2).
