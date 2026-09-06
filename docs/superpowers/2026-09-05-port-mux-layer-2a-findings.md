# Plan B1 (packaging) — findings

What executing Plan B1 taught, written while the evidence was still to hand. The plan itself is
`docs/superpowers/plans/2026-09-05-port-mux-layer-2a-packaging.md`; the design is
`docs/superpowers/specs/2026-09-05-port-multiplexer-design.md`. Both were corrected during execution
and now agree with the code.

**What B1 did:** renamed `webrun-streams-port` to `@statewalker/webrun-rpc`; moved `MessageTarget`
and the port layer into it from `webrun-streams`; retyped the RPC tier from `MessagePort` to
`MessageTarget`; made `PortMux.openPort` asynchronous. Range `1279cf9..0ed16a0`.

**End state:** `webrun-rpc` 75 tests / 13 files, `webrun-streams` 165 / 18, repo-wide 721 passing /
5 skipped. `pnpm -r typecheck` exit 0. `npx changeset status` exit 0.

---

## 1. A green signal for an untested claim, three times, three mechanisms

Every one of these reported success while verifying nothing. They are the same defect wearing
different clothes, and none was caught by reading — only by someone checking what the command
actually did.

**A missing script exits 0.** `pnpm --filter <pkg> <missing-script>` prints
`None of the selected packages has a "<script>" script` and **exits 0**. `webrun-rpc` had no
`typecheck` script; the plan called it three times, and Task 4's *red phase is a typecheck* — it
would have reported a passing red phase having compiled nothing. Found by the implementer, not a
review.

**`tsc` did not compile the tests.** `webrun-rpc/tsconfig.json` includes only `src`, and vitest
transpiles without typechecking. A test written to prove a **type-level** property was itself never
typechecked, so the plan's proof step could not produce the error it predicted. Adding
`tsconfig.tests.json` surfaced **20 pre-existing type errors** across four test files, all the same
mistake: an arrow listener returning `Array.push`'s number where `MessageListener` expects `void`.
Harmless at runtime, which is why they survived.

**Six primitives were tested only against a transport that satisfied the old signature.** The whole
point of Task 3 was retyping `MessagePort` → `MessageTarget`, but six of the eight primitives were
exercised solely over a real `MessageChannel` — which satisfies *both* signatures. Their tests would
have passed identically had the task never happened. Each now runs over a plain `MessageTarget` pair,
and each was proven load-bearing by reverting its parameter and confirming a named typecheck error.

**The rule this yields:** a test for a type-level change must be *typechecked*, and must use a value
that fails the old type. A passing suite over a permissive fixture proves nothing was broken, never
that anything was gained.

---

## 2. `git checkout --` restores the last *committed* state

Third incident of this session, and the one that finally showed the rule.

Standing guidance was "never `git checkout -- <directory>`". Task 3's implementer obeyed it, used an
exact file path — and still lost its work, because the file held uncommitted changes and `checkout`
reverted to the last commit. It was caught only because the tool announced the file had changed on
disk; the implementer reapplied and re-verified before committing.

**The hazard was never directories.** It is uncommitted work, and a file path does not protect you.
The correct pattern, which a reviewer arrived at independently in Plan A: **copy the file to a
scratch path outside the repo before mutating, and copy it back**, verifying with `diff` or `md5sum`.
Every mutation probe in this plan used it after that point.

---

## 3. Making a function `async` changes its error contract

Task 4 made `openPort` asynchronous. That converted its synchronous guard throws — `maxPorts`
exceeded, mux closed — into **rejected promises**, so three tests asserting
`expect(() => …).toThrow()` failed deterministically. The compiler cannot catch this: the types are
fine, the semantics moved.

The implementer stopped and asked rather than rewriting the assertions. That was correct: rewriting
them unilaterally would have looked like a clean task while hiding a caller-visible contract change.

The ruling was to convert to `await expect(…).rejects.toThrow(…)`, preserving the error type,
triggering condition and every surrounding assertion — because once `openPort` is async, a test
asserting "throws synchronously" asserts something **false about the intended design**. Recorded in
the spec, since a caller wrapping a bare call in `try`/`catch` no longer catches.

A related subtlety worth keeping: **an async function with no internal `await` still runs
synchronously to its `return`.** Two un-awaited `openPort` calls in a test are therefore correct —
the mux mutates regardless, and neither call can reject. A reviewer caught that; it would otherwise
have been "fixed" into needless awaits.

---

## 4. Only the whole-branch view saw the release blocker

Five task reviews passed. The final review found that `.changeset/credit-based-flow-control.md` still
keyed `@statewalker/webrun-streams-port`, so **`npx changeset status` failed hard and the repo could
not cut a release**. No task's diff contained that file, so no task reviewer had reason to look at it.

It also found the two changesets contradicting each other — one bumping `webrun-streams` *minor* to
announce `multiplexPort`, the other bumping it *major* for removing it, both shipping in one release.

**Task-scoped review cannot see cross-cutting state.** Budget a whole-branch pass that reads the
release configuration, not only the code.

---

## 5. Specifications rot at the seams of a decision

When `openPort` went async, **only D2 was amended**. The spec's `PortMux` interface block still
declared a synchronous return and the prose below it still said "returns synchronously" — and that
block is what Plan C's native implementations will be written against. D1 still said `MessageTarget`
lives in `webrun-streams`, contradicting D22, which had moved it.

Amending the decision is not amending the document. After changing a decision, grep for every other
place that states the same fact.

Two more of my own claims were wrong and were corrected by measurement:

- I wrote that `flow-control.ts` and `uint32.ts` "have had no consumer since Plan A". False —
  `emulate-mux.ts` imports and uses **both** today. They only diverge after Plan C, where
  `flow-control` stays dormant as D13's windowing mechanism and **`uint32` becomes genuinely dead**,
  an internal codec for a wire format that will not exist. It is on Plan C's deletion list.
- A README table cell said `openPort` "Throws `RangeError` past `maxPorts`" — wording the plan
  mandated **verbatim**, and false after Task 4. The paragraph below it was right, but a reader
  scanning the API table would write a `try`/`catch` that never fires. Precision in a plan
  propagates errors as faithfully as it propagates correctness.

---

## 6. Counts in a plan go stale; conservation identities do not

Two per-file test counts in this plan were wrong (`message-target.test.ts` holds 2 tests, not the 6
guessed), continuing a run from Plan A. Both were surfaced because implementers were told to
**report the real number rather than reconcile to the stated one**.

What actually caught errors was not a count but an identity: **201 + 35 = 165 + 71 = 236**. A test
count moving between packages is bookkeeping; a test count *disappearing* is a lost test, and only
conservation distinguishes them. Write the invariant, not the number.

---

## Open question, deliberately not decided

Moving `MessageTarget` gave `webrun-http-browser` a dependency on `webrun-rpc` for **18 lines of
`interface`** and no runtime code. The final review argues this is the exact coupling D22 refuses
when it keeps `Duplex` in `webrun-streams`: `webrun-http-streams` consumes `Duplex` and touches
nothing port-related, and by identical logic `webrun-http-browser` consumes `MessageTarget` and
touches nothing RPC-related.

Both are structural interfaces rather than implementations, so the symmetry argument is real. Against
it: `MessageTarget` is the port generalisation, and placing it with the port layer was a deliberate
decision. Left to the human, with three options recorded — leave it, move `MessageTarget` back to
`webrun-streams` and re-export from `webrun-rpc`, or split the generic message shapes from the
port-specific types.

## For whoever writes Plan B2 and Plan C

- `webrun-rpc` still contains a MessagePort transport adapter (`byte-channel`, `connect-serve`) that
  Plan C deletes. Its own README and CHANGELOG describe the package as if that removal has already
  happened; the transitional state is noted there. **Plan C deletes 11 of `webrun-rpc`'s 75 tests
  unless `duplexOverPort`'s conformance run lands in the same change.**
- `uint32.ts` and `tests/uint32.test.ts` go on Plan C's deletion list.
- `openPort` is `(meta?) => Promise<MessageTarget>`, and guard failures reject rather than throw.
- No close is observable at layer 1 — see the Plan A findings document. Layer 2 must send its own
  end-of-stream message, and a stream on a rejected port has only its timeout.
