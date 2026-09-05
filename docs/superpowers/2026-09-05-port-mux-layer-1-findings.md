# `webrun-ports` layer 1 — tests and findings

What the test suite covers, why each part exists, and what executing the plan taught that the plan
itself got wrong. Written at the end of Plan A (`c7393b4..2af8f65`) so the reasoning survives the
scratch directory that held it.

**Companion documents:** the design is
`docs/superpowers/specs/2026-09-05-port-multiplexer-design.md`; the plan is
`docs/superpowers/plans/2026-09-05-port-mux-layer-1.md`. Both were corrected during execution and
now agree with the code.

---

## The suite

**34 tests in 5 files.** Repo total 717 passing / 5 skipped.

| file | tests | what it pins |
| --- | --- | --- |
| `structured-codec.test.ts` | 5 | Envelopes pass through unencoded; transfer lists forwarded; an empty transfer list is *omitted* rather than passed; non-envelope traffic ignored so a shared transport is not corrupted. |
| `virtual-port.test.ts` | 8 | Listener registration and removal, delivery, close idempotence, inertness after close, containment of a throwing listener. |
| `multiplex-port.test.ts` | 6 | Open/accept/reject/deliver over a **real `MessageChannel`**, bidirectional traffic, even/odd id parity observed on the raw wire. |
| `invariants.test.ts` | 7 | Drop-never-queue, isolation, per-port ordering, bidirectional idempotent close, local `maxPorts`, and composability — a mux running over another mux's virtual port. |
| `lifecycle.test.ts` | 8 | Id retirement under churn, inbound `maxPorts` rejection, duplicate-`OPEN` guard, `close()` teardown, `openPort` after close, listener removal, id-collision guard. |

Two deliberate choices in how these are written:

**Tests run against a real `MessageChannel`, not a stub.** That also serves as a standing check that
a `MessagePort` satisfies `MessageTarget` structurally, which is the assumption the whole layering
rests on.

**No fixed tick counts anywhere.** Every wait is a condition poll with a labelled timeout
(`waitFor`). See finding 3 for why.

---

## How absence is asserted

A condition wait cannot prove a negative, and "nothing arrived" is trivially true if nothing was
ever sent. Every absence assertion in this suite therefore waits on a **positive sentinel** that
ordering guarantees will arrive *after* the thing being asserted absent, then asserts the absence.

| test | sentinel | ordering guarantee |
| --- | --- | --- |
| rejection: `onPort` returns `false` | the rejection's `close` reaching the opener | per-channel FIFO on one `MessagePort`, plus the mux's listener completing synchronously before the test's counter |
| unknown id is dropped | a real message arriving on a genuine port | forged message, `open` and real message all travel one channel in program order |
| messages after peer close are dropped | a later message envelope on the wire | `close()` runs `open.delete(id)` synchronously *before the next line sends* — stronger than FIFO |
| both ends close | the close envelope counted on the raw wire | one event dispatch runs all listeners synchronously; `waitFor` can only poll on a later macrotask |

If you add an absence assertion, use this pattern. Per-channel FIFO orders messages on **one**
`MessagePort`; it does **not** by itself order events across two channels or across a mux hop.

---

## Mutation coverage

Every invariant has a mutation that kills it, measured rather than predicted.

| mutation | killed by |
| --- | --- |
| `open.delete(id)` in `requestClose` (local close) | churn test — `RangeError` at cycle 4 |
| `open.delete(id)` in the inbound close branch | churn test — times out |
| inbound `open.size >= maxPorts` check | inbound-OPEN rejection test |
| duplicate-`OPEN` guard | duplicate-OPEN test |
| `await port.close?.()` in `close()` | teardown test |
| `muxClosed` check in `openPort` | two tests expecting a throw |
| `removeEventListener` in `close()` | listener-removal test |
| `if (closed) return;` in `deliver` | after-close listener test |
| `if (closed) return;` in `postMessage` | inertness test |
| the `try`/`catch` around a listener | throwing-listener test |
| `nextId += 2` → `+= 1` | id-parity test |
| deliver to every handle instead of `open.get(id)` | isolation test |
| `n >>> 0`-style: `isEnvelope` always true | non-envelope test |
| the id-collision guard in `openPort` | collision test |

**One mutation survives**, reported rather than papered over: `post()`'s own `if (muxClosed) return;`.
Every call site is independently guarded before it can be true, so no test reaches it — *except*
under a synchronously-reentrant `MessageTarget` whose `postMessage` reenters `mux.close()`
mid-teardown, which a reviewer constructed and verified. Nothing a real `MessagePort` or this
package's composability pattern produces. The guard stays; the honest description is "unreachable
under any transport this package ships or tests", not "dead code".

Two paths are knowingly uncovered and neither is load-bearing: deleting `if (!handle) return;` from
the message branch throws synchronously inside the raw port's own listener, outside any assertion's
reach (the suite still exits non-zero, so CI fails); and `post()` swallows transport errors silently
by design, since layer 1 holds no state to unwind.

---

## Findings from execution

These are things the plan or the spec asserted that turned out to be wrong. They are recorded
because each was found by measurement after passing review by inspection.

### 1. Three separate "this guard is unreachable" arguments, all refuted

- The `deliver` guard was argued unreachable because `markClosed()` clears the listener set. It is
  reachable: `addEventListener` has **no `closed` check**, so a listener registered after close
  repopulates the cleared set and the guard is the only thing preventing delivery.
- `open.delete(id)` was called "bookkeeping hygiene, not a behaviour anything can observe" — by this
  plan, in writing, with an instruction not to test it. Without it ids are never retired, `maxPorts`
  bounds *total opens* rather than concurrency, and a mux dies at cycle 1024 of a 5000-cycle churn
  with a `RangeError`, violating spec D19.
- `post()`'s `muxClosed` guard was called provably dead. A reaching path exists (above).

In every case the argument traced call sites and looked sound; in every case it was settled only by
someone constructing the path. **Treat "I traced it and it cannot be reached" as a hypothesis in
this codebase, not a conclusion.**

### 2. No close is observable at layer 1, and it constrains the layer above

When a `close` envelope arrives, listeners are cleared, `postMessage` goes silently inert, and
`reason` is discarded rather than surfaced. This is true of an orderly peer close as much as a
rejection — a closed port is indistinguishable from a working one nobody is answering.

This follows from spec D3 and is not a defect. But it means **D8's "explicit close notification from
the peer" cannot be layer 1's `close`**: the layer above must send its own end-of-stream message on
the port before the port closes. A stream opened on a port the peer *rejects* gets no such message
at all, so the per-stream timeout is its only signal. Both are recorded in the spec as testable
requirements on Plan B.

### 3. Fixed tick counts caused a measured 8% flake

Tests waited a fixed number of macrotask ticks for `MessagePort` delivery. Measured: **2 failures in
25 runs** on unmutated code — and **zero in 15 isolated runs of the same file**, because the race
only surfaces under the load of several test files running concurrently. Running the file alone
would have shown green indefinitely; the bug existed only in the configuration CI uses.

Replaced with condition polling. 45 consecutive clean runs since.

### 4. A verification step can verify the wrong artifact

The plan's check for the README example ran a **padded copy** containing a 50 ms sleep the README
never had. It printed `README example OK` for a program that was not the published one — the
committed example exited 0 printing nothing. A green signal for an untested claim is worse than no
check, because it stops anyone looking.

The example now awaits its reply and teaches that delivery is asynchronous. When verifying a
document, extract the artifact **from the committed document**, not from the script that generated
it.

### 5. A test named for coverage it did not have

`refuses to open beyond maxPorts, and rejects an inbound OPEN beyond it` never exercised the inbound
path. Renamed to what it does, and the inbound assertion written separately in `lifecycle.test.ts`.

### 6. Cumulative test totals in a plan go stale immediately

Absolute counts (`expect 24 tests`) were wrong in three separate task briefs because fix rounds added
tests after the plan was written. Per-task deltas (`+2 here`) would have survived. This cost four
corrections across two plans.

---

## For whoever writes Plan B

- Layer 2 must send its own end-of-stream message; layer 1's `close` is invisible to it (finding 2).
- A stream on a rejected port must fail rather than hang — the per-stream timeout is the only signal.
- The `meta` field carries layer 2's port-kind discriminator (`{ kind: "control" }` /
  `{ kind: "stream" }`); layer 1 passes it through without inspecting it.
- `PortMux.maxMessageSize` is reported, never enforced. Layer 2 chunks to it.
- Use `waitFor`-style condition polling in tests, never tick counts, and use the sentinel pattern
  above for absence assertions.
