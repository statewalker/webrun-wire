# Plan C1 (the byte codec) — findings

What executing Plan C1 taught, written while the evidence was still to hand. The plan is
`docs/superpowers/plans/2026-09-06-port-mux-layer-3a-byte-codec.md`; the design is
`docs/superpowers/specs/2026-09-05-port-multiplexer-design.md`, which is the binding authority and
was checked against the code for every claim below. Its three predecessors are
`2026-09-05-port-mux-layer-1-findings.md` (Plan A), `2026-09-05-port-mux-layer-2a-findings.md`
(Plan B1) and `2026-09-06-port-mux-layer-2b-findings.md` (Plan B2).

**What C1 did.** `@statewalker/webrun-msgpack` gained `msgpackCodec`, a `PortCodec` that turns one
`multiplexPort` envelope into one msgpack frame and one `postMessage`. The two codecs in play —
`msgpackCodec` and `webrun-rpc`'s `structuredCodec` — are now pinned against each other on the real
traffic layer 2 puts on the wire. The **unmodified** L0–L6 conformance suite runs over the new stack
on a transport that carries bytes and refuses anything else, **twice**: with framing unlimited, and
with frames capped at 64 KiB so `duplexOverPort`'s `toChunks` path is exercised. And the cost of
bridging a byte transport to a real `MessagePort` was measured, because Plan C2 is gated on it.

No adapter was touched. Nothing was deleted. `packages/webrun-rpc/` was not modified.

**Range:** `25ce027..48d16f7` for the implementation, plus this document's own commit, which is the
branch tip. (Plan B2's findings note why naming a fixed end SHA goes stale; the same applies here.)

**End state, measured rather than carried forward:**

| | before | after |
| --- | --- | --- |
| `webrun-msgpack` | 25 tests / 1 file | **84 tests / 4 files** |
| `webrun-streams-ws` | 11 tests / 1 file | **11 tests / 1 file**, plus an opt-in `test:bench` (1 test, outside the default run) |
| `webrun-rpc` | 120 tests / 19 files | 120 / 19 — untouched |
| repo-wide (`pnpm -r --no-bail test`) | 766 passed / 5 skipped *(at plan start)* | **825 passed / 5 skipped** |

`webrun-msgpack`'s four files: `msgpack.test.ts` 25 (the pre-existing stream codec), the new
`port-codec.test.ts` 18, `codec-equivalence.test.ts` 19, `conformance-bytes.test.ts` 22 (two
conformance runs × 11 levels). The 5 skips are unchanged and all environment-gated (`-webrtc`,
`-peerjs`, `-livekit`, one libp2p case, one `site-builder-jspm-demo` case).
`npx changeset status` exits 0.

**A note on the repo-wide baseline, because it caused an arithmetic dispute mid-plan.** 766/5 is the
figure at *plan start*. Tasks 1–2 added 37 tests, so the correct pre-Task-3 figure was 803/5, and
814/5 post-Task-3-before-its-fix-round. All the numbers were right; only their labelling was
ambiguous. Plan A finding 6 said absolute counts in a plan go stale immediately, and this is the
third plan in a row to prove it.

---

## The finding of this plan: `maxMessageSize` bounds the payload, not the frame

**This is a gate on Plan C2**, and it was found by a reviewer asking why a conformance run with no
`maxMessageSize` set could claim the byte path had "nothing left to prove".

`duplexOverPort` applies `toChunks(maxMessageSize)` to the **payload** —
`packages/webrun-rpc/src/duplex-over-port.ts:447`, the only enforcement point anywhere; layer 1
stores the value and reports it and never inspects a payload. The envelope framing — `WireChunk`,
`callPort`'s `{type, channelName, callId, params}`, the mux's `{type, id, payload}`, then the
codec — is added **on top, afterwards**.

Measured over `msgpackCodec`, the overhead is **`87 + len(callId)` bytes, and it is not constant**:

- `callId` is `` `call-${Date.now()}-${String(Math.random()).substring(2)}` ``
  (`call-port.ts:52`), whose real length varies **31–40** characters *per chunk*, because
  `Math.random()` drops trailing zeros;
- the port id's msgpack integer width adds **0–4**;
- the channel name adds **1** for `"out"` over `"in"`;
- a chunk at or above 64 KiB adds **2** as the payload's `bin` header widens.

**Worst case 134 bytes; practical margin 256.**

Reproduced independently for this document, on the shipped stack, with a 512 KiB body:

| `maxMessageSize` | what an adapter author would mean by it | largest frame actually posted | overhead |
| --- | --- | --- | --- |
| `16 * 1024` | an `RTCDataChannel`'s conservative ceiling (`-webrtc`'s own `DC_MTU`) | **16,508 B** | 124 |
| `12 * 1024` | LiveKit's safe packet size (`-livekit`'s own `LIVEKIT_SAFE_MTU`) | **12,413 B** | 125 |
| `64 * 1024` | the conformance run's cap | **65,662 B** | 126 |

Task 3 measured 16,507 / 12,411 / 65,664 for the same three; the one-and-two-byte disagreements are
the `callId` and port-id width variance, not a disagreement about the finding. Over eight runs at a
16 KiB cap with a 1 MiB body — several thousand chunks, so several thousand `callId`s — the largest
overhead observed was **126 bytes**. So: 134 is a computed worst case, not an observed one, and the
honest statement is that the observed range is 124–126 with a modelled ceiling of 134. Either way
256 covers it and the transport's hard limit does not.

**The consequence is exactly risk R3's failure mode.** An adapter author who reads D10 ("layer 2
chunks to it") and sets `maxMessageSize` to the transport's hard limit overruns it on the first
full-size chunk — and LiveKit drops an oversized packet silently: the body is delivered as zero
bytes, with no error on either side. All three of C2's adapters have hard ceilings.

**What has been done about it, and what has not.** Spec D10 was amended immediately, mid-plan
(commit `9fae89b`), rather than waiting for this document — the reasoning being that C2 will be
planned against D10 and leaving a measured falsehood in the binding authority while writing that
plan is how the LiveKit bug ships twice. Two things still carry the false statement, and both are
named for C3 below: `packages/webrun-rpc/src/port-types.ts:53-56` ("Layer 1 does not enforce it; it
reports it so layer 2 can chunk to fit"), which is where the next adapter author actually reads it;
and — found while writing this document — **the spec's own `PortMux` interface block still says
"Layer 2 chunks to it (D10)"**, two hundred lines below the correction. That is Plan B1 finding 5
reproduced verbatim: amending the decision is not amending the document.

---

## The measured mutation table

Every mutation this plan ran, with what it *actually* killed beside what was *predicted*. Each was
applied by copying the file to a scratch path, editing in place, running, copying back and
confirming with `diff` — never `git checkout --` (Plan B1 finding 2). Rows marked **re-measured**
were run again from scratch while writing this document, against the shipped code.

| # | task | mutation | predicted | measured | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | delete the `try`/`catch` in `read`, call `deserialize` bare | 3 — invalid msgpack, empty bytes, truncated frame | **2** — invalid msgpack, truncated frame. Implementer 2×, reviewer 2×, **re-measured** 1× | **discrepancy — overcount.** Empty bytes never reaches `deserialize`: the `byteLength === 0` early return fires first |
| 2 | 1 | `isEnvelope` → `true` unconditionally | 2 — "not an envelope", and the plain-object junk row | **1** against the as-written suite, 2× | **discrepancy — overcount.** A plain object is refused by `toBytes` one level earlier and never reaches `isEnvelope` at all |
| 2b | 5 | the same mutation against the **shipped** suite | — | **2** — "not an envelope", and the id-check test the fix round added; the plain-object row still survives | the predicted *number* is now right for the wrong reason. Worth stating: a count that matches is not evidence the mechanism was traced correctly |
| 3 | 1 fix | remove **only** `bytes.byteLength === 0` | the report had claimed this guard was the empty-bytes floor | **0 kills**, 2× | **the report's claim was false.** `deserialize` throws on empty and the `catch` absorbs it |
| 4 | 1 fix | remove the length guard **and** the `try`/`catch` | — | **3** — empty, invalid, truncated | the empty case is pinned by the *conjunction*; neither guard alone is its floor |
| 5 | 1 fix | delete `toBytes`'s `ArrayBuffer.isView` branch outright | the report had claimed the offset-view test would fail | **0 kills** before the fix; exactly the new `DataView` test after. Implementer + reviewer, 2× each | **the report's claim was false.** An offset `subarray` is still a `Uint8Array` and returns one line earlier, so the branch was reached by nothing |
| 6 | 1 fix | reduce that branch to `new Uint8Array(view.buffer)` — the exact arithmetic error the report named | as above | **0** before; **1** (the `DataView` test) after, 2× | same; a real branch that no test reached, with any arithmetic |
| 7 | 1 fix | delete both `isEnvelope` id checks (`typeof … !== "number"`, `!Number.isInteger \|\| < 0`) | — | **0 kills** before the fix; **1** (the new id test) after, 2× | a second unpinned branch, found by asking rather than assuming. The only shape-rejecting row had no `type`, so it died on the `type` disjunction first |
| 8 | 2 | `msgpackCodec.read` delegates to `structuredCodec.read`; `post` still serialises | `port-codec.test.ts` fails, **`codec-equivalence.test.ts` passes** | `codec-equivalence` **12 of 13** failed (18 of 19 on the final 17-row file); `port-codec` 8 of 18 | **discrepancy — undercount.** The equivalence file is not inert under this mutation, it fails almost entirely, on the `toBeDefined()` floor before the `toEqual` the prediction was about |
| 9 | 2 (reviewer) | make `read` re-materialise the keys msgpack dropped | — | every equivalence row stays green; **only** the `"key" in obj` test fails | proves that one test is the sole detector of the undefined-key asymmetry, and that `toEqual` genuinely cannot see it |
| 10 | 3 | `read` → `undefined` unconditionally | — | **10 of 11**, 2×; every failure a 5 s timeout. Survivor: L5 "idempotent serve teardown" | |
| 11 | 3 | `post` shifts the port id by 1 | — | **10 of 11**, 2×, the identical set and the identical survivor | envelopes decode cleanly and route to a port nobody listens on |
| 12 | 3 | substitute `structuredCodec` on the byte pipe (not a source mutation — a probe) | — | **10 of 11** | proves the pipe's `Uint8Array` guard is live, i.e. the byte path is a byte path and not a `MessageChannel` in disguise |
| 13 | 3 (reviewer) | swallow **only** layer 2's `stream-abort` message | — | **L3 alone** | proves cancellation genuinely traverses the byte wire rather than short-circuiting in process |
| 14 | 3 (reviewer) | drop every layer-1 `close` envelope | — | **11/11 green.** **Re-measured** for this document across the whole repo: all 84 `webrun-msgpack` tests green (both byte-pipe conformance runs included), both `webrun-rpc` conformance runs green; the *only* test anywhere that notices is `webrun-rpc`'s own id-retirement churn test (120 → 119) | **a suite coverage gap, not a codec property.** No conformance level is sensitive to layer 1's close at all. Carried to C3 |

Task 4 ran no mutations: it is a measurement, and its equivalent of a mutation is the finding that
its own artifact never executed (below).

### The pattern in the discrepancies

**Four of this plan's mutation predictions came out wrong**, and unlike Plan B2 the split is
lopsided: rows 1, 2 and 2b are **overcounts** and row 8 is an **undercount**.

The three overcounts have **one cause, and it is not the cause B2's overcounts had**. In B2, a
mutation that killed less than predicted was diagnostic of a *vacuous test* — an assertion satisfied
whether or not the mechanism worked. Here, every test involved is real and has a real floor; what
the prediction got wrong is **which guard is the floor**. An earlier guard short-circuits, so the
test dies before it reaches the line the prediction was about:

- empty bytes never reaches the `try`/`catch`, because the length guard returns first (row 1);
- a plain object never reaches `isEnvelope`, because `toBytes` refuses it first (row 2);
- an offset `subarray` never reaches the `isView` branch, because it is a `Uint8Array` and matches
  the branch above (rows 5–6).

Call this a **misattributed floor**: the test is not vacuous, its position in the file just implies
a mechanism it does not exercise. It is worse than harmless, because it makes a *neighbouring*
branch look covered when nothing reaches it — which is exactly what rows 5, 6 and 7 found. Two real
branches of the shipped codec (`toBytes`'s `isView` arm, `isEnvelope`'s id checks) were pinned by
nothing at all, and both were found by re-running a claim the report had asserted rather than
measured.

The single undercount (row 8) is B2's familiar shape: one shared mechanism serves more consumers
than the prediction traced.

And row 2b is the one worth keeping: re-run against the shipped suite, the mutation kills **exactly
the predicted number** — while the specific test the prediction named still survives, and a
different test added later supplies the second kill. **A matching count is not evidence the
mechanism was traced correctly.** Report which tests died, not how many.

### Three report claims that were asserted rather than measured, and were false

Recorded because they are the same failure class as the plan's own wrong predictions, and because
two of this plan's four fix rounds turned on them:

1. Task 1's report: "the guard that protects the empty-input case is the length check, not the
   exception handler." Row 3 — false; it is the conjunction.
2. Task 1's report: the offset-view test "would fail if the offset/length arithmetic in `toBytes`
   were wrong". Rows 5–6 — false; the branch was unreachable from the suite.
3. Task 2's report: three arithmetic statements about its own row counts (10 rows not 9, 11 not 10,
   12 failures not 11). The headline test counts were right; the prose describing them drifted.

The corrective habit is Plan A's and B2's, unchanged: **run it, run it more than once, and report
the tests that moved rather than the number you expected.**

---

## The bridge-cost measurement, which Plan C2 is gated on

Spec "Cost of bridging to a real `MessagePort`" asks for this to be measured on `-ws` before the
other two adapters commit to a shape. Three agents ran it: the implementer 3× in Task 4, a reviewer
2× independently, the implementer once more in the fix round, and the re-reviewer once. A WebSocket
round trip, against the same round trip pumped through a real `MessageChannel` with the caller
talking only to `port1`.

| body | implementer ×3 | reviewer ×2 | fix round | re-reviewer | range | reading |
| --- | --- | --- | --- | --- | --- | --- |
| 64 B | 1.51, 1.49, 1.31 | 1.27, 1.37 | 1.47 | — | **1.27–1.51×** | consistent, real |
| 4096 B | 1.23, 1.25, 1.37 | 1.22, 1.23 | 1.14 | — | **1.14–1.37×** | consistent, real |
| 64 KiB | 1.35, 1.10, 1.03 | 1.08, 1.12 | 1.22 | **0.89** | **0.89–1.35×** | **inconclusive** |

A bookkeeping wrinkle rather than a hidden number: the re-reviewer's run is recorded in the ledger
only at 64 KiB (direct 87.0 ms, bridged 77.1 ms), because that is the size at which it changed the
conclusion; its other two sizes were not written down, so the sample counts differ per row — six at
the small sizes, seven at 64 KiB. The fix round's 1.14× at 4 KiB sits slightly below the band the
first five runs established (1.22–1.37×) and is included rather than trimmed.

Absolute per-round-trip overhead at the two small sizes is roughly **12–20 µs**, near enough
independent of payload size — consistent with a mostly fixed cost: one extra macrotask hop plus a
structured clone of a small typed array.

**The honest conclusion is narrower than one ratio.** Small messages carry a real and consistent
cost. The 64 KiB figure is **not merely noisy — it is inconclusive**: the sixth run measured
**0.89×**, bridged *faster* than direct (87.0 ms vs 77.1 ms). Five of six runs put bridged behind,
one put it ahead, and the spread straddles both "negligible" and "a third slower". Nothing about
large bodies should be claimed from this. The `.slice()` copy in the inbound pump is the named
suspect for the variance and was **not** isolated; the harness times whole round trips and cannot
decompose them.

**Node only.** This uses Node's `node:worker_threads`-backed `MessagePort` and the `ws` package. A
browser's structured clone, its macrotask interleaving around `postMessage` and its WebSocket are
different code paths written by a different engine team — and a browser is the environment where
transferring a port into a worker or iframe is the point. **This measurement does not establish the
browser number**, and if C2's decision rests on it, it needs its own run.

One methodological residual: every size runs direct immediately before bridged, in the same process,
in that fixed order, so JIT and socket warm-up could flatter bridged. Small; it does not change the
qualitative reading.

### Two options, deliberately not chosen

**Option A — a real `MessagePort`.** The adapter hands back a transferable port, as the spec
designs it. Cost: the small-message tax above, on Node, unmeasured in a browser. Benefit: it can be
`postMessage(…, [port])`-ed into a worker or an iframe, which is the entire reason the spec wants a
real port.

**Option B — a plain `MessageTarget` object.** Costs nothing over the direct path, because it *is*
the direct path wrapped. It **cannot be transferred**. Choosing B is choosing to give that up.

**This choice is the human partner's.** Nothing in this plan selects one, and the numbers above are
the whole of the evidence either way.

### How to re-run it

`pnpm --filter @statewalker/webrun-streams-ws test:bench`. It is deliberately outside the default
`**/tests/**/*.test.ts` glob (its own `vitest.bench.config.ts`, unwired from `turbo.json`'s test
pipeline) because it takes 30–60 s, asserts only completion, and its value is one-time. Do **not**
"fix" it by renaming it to `.test.ts` or widening the shared include; the file's header comment says
so and points here.

---

## A third instance of "a green signal for an untested claim" — as one pattern

Plan B1 recorded this shape three times and called them "the same defect wearing different clothes".
This plan produced a fourth and a fifth instance, and they belong together rather than as separate
anecdotes.

| # | plan | the green signal | what was actually verified |
| --- | --- | --- | --- |
| 1 | B1 | `pnpm --filter <pkg> <missing-script>` prints "None of the selected packages has a …" and **exits 0** | nothing — including a red phase that was a typecheck |
| 2 | A | a README example check that printed `README example OK` | a **padded copy** containing a 50 ms sleep the README never had; the committed example exited 0 printing nothing |
| 3 | B2 | `pnpm -r typecheck` bails on the first failure and names two apps | five apps fail; three were behind the bail |
| 4 | C1 | `bridge-cost.bench.ts` committed as "a vitest test file, so it runs in CI" | the root config's include is `**/tests/**/*.test.ts`. The package's test count never moved (11 before, 11 after) and an explicit run reports `No test files found, exiting with code 1`. **The committed harness ran never**, while looking like coverage |
| 5 | C1 | the bench itself, run without `--reporter=verbose`: `Tests 1 passed (1)`, **exit 0**, and *no table* | nothing you can read. Confirmed by two agents; the flag is now pinned inside the script |

The mechanism differs every time — an exit code, a substituted artifact, a fail-fast runner, a glob,
a reporter — and the shape never does: **a command reports success while the thing you care about
was not exercised, and the success is what stops anyone looking.** Instances 4 and 5 are the same
artifact failing this way twice, at two different layers, within one task.

The generalisation that would have caught all five: **a verification must name what it would have
looked like had it failed.** "No test files found" and "1 passed with no output" are both
distinguishable from a real pass — but only if someone asks what a real pass looks like first.

Instance 4's fix is worth recording too, because the obvious ones were both wrong. Renaming to
`.test.ts` or widening the shared glob would have folded a 30–60 s benchmark that asserts only
completion into every CI run of every package — contradicting the harness's own "it reports, it does
not gate" premise. It got an opt-in script instead, and this document carries the number, which is
the measurement's durable form.

---

## Typechecking `webrun-msgpack`'s tests for the first time: zero errors

Plan B1's equivalent moment surfaced **20** pre-existing type errors in `webrun-rpc`'s four test
files, all the same mistake (an arrow listener returning `Array.push`'s number where
`MessageListener` expects `void`). The comparison is the point, so the number is stated even though
it is the boring one:

`packages/webrun-msgpack/tsconfig.tests.json` was added and run for the first time against
`tests/msgpack.test.ts`. **Zero errors.** The file compiled cleanly the first time it was ever
typechecked.

Two things came with it, neither a type error:

- `lint` was `biome check --write .` — a script that *rewrote* the tree instead of gating it. Now
  `biome check src tests`, read-only.
- `typecheck:tests` silently requires the sibling packages' gitignored `dist/` to exist, because
  each package's `tsconfig.json` replaces the root `paths` map wholesale and workspace imports
  therefore resolve through `node_modules` to `./dist/index.d.ts`. Task 3 made this worse by
  importing `@statewalker/webrun-streams-conformance`: a fresh clone now gets `TS2307` from
  `pnpm --filter @statewalker/webrun-msgpack typecheck:tests` until that package is built, and
  **`turbo.json` declares no `typecheck*` task at all**, so nothing enforces the ordering. The
  identical failure was reproduced in `webrun-rpc` by moving the conformance `dist/` aside. A
  `paths` override was deliberately declined: it would make one package diverge from a sibling with
  the same import and paper over a build-order fact. The debt is real and now belongs to two
  packages.

---

## Where this plan was wrong

Seven defects in the plan's own text, plus one report-level overreach. Every one was found by an
implementer or a reviewer measuring something the plan asserted.

| # | what the plan said | what the code said |
| --- | --- | --- |
| 1 | Task 4: the file is `bridge-cost.bench.ts`, and "it is a vitest test file so it runs in CI" | **both wrong, and the second is the expensive one.** No `*.bench.ts` precedent exists anywhere in the repo, and the root config's include never matches it. The committed artifact ran never |
| 2 | Task 1: the new tests are **+15** | **+16.** 6 round-trip + 7 templated junk cases + 3 refusal tests. Reported by the implementer rather than reconciled to the plan's number, per G8 |
| 3 | Tasks 1 and 3: `git add … pnpm-lock.yaml` in the commit template | `pnpm-lock.yaml` is **gitignored** here, with a comment in `.gitignore` explaining why: this repo is a multirepo member whose `workspace:*` deps can point at packages in other repositories, so the umbrella's lockfile is authoritative. `git add` refuses it without `-f` |
| 4 | Task 4 "Consumes": `byteChannelFromWebSocket` | it returns an async-iterable `ByteChannel`, **not** a `MessagePort`. Nothing in `webrun-streams-ws/src/` produces a `MessagePort` from a WebSocket today, so the harness is synthetic **by necessity** — it builds the bridging shape by hand. Only the `WebSocketLike` *type* is imported from the package |
| 5 | Task 2: the equivalence list is "everything layer 2 actually puts on the wire" | it omitted **five present-but-undefined keys** across four call sites — `multiplex-port.ts` always posts `meta` on open and `reason` on close, `duplex-over-port.ts:452` builds `{done, value, error}` unconditionally, `listen-port.ts:43` posts `result` on the error path too — and one close shape entirely (`reason: "rejected"`, `multiplex-port.ts:74`). Six rows were added; the list is 17 rows now, each naming the `file:line` it reproduces |
| 6 | Task 2: the realistic confirmation row "will not compare equal across the codecs" | it does. Vitest's `toEqual` treats an own property present-with-`undefined` as equivalent to absent, so the row belongs in the equivalence block. The blind spot and msgpack's lossy set coincide *precisely*, which is why the block is sound and why the asymmetry needs `"key" in obj` to detect it |
| 7 | Task 3: repo-wide baseline 766 / 5 | 766/5 is the **plan-start** figure; the measured pre-Task-3 baseline was 803/5. Established by moving the task-added files aside and re-measuring |
| 8 | Task 3's *report*: "the stack itself has nothing left to prove on the byte path" | overreach. `maxMessageSize` was unset on both muxes, so `toChunks` never ran — and every byte transport C2 targets imposes a frame limit and will engage it on its first real body. Corrected **in the artifact**: a second conformance run at a 64 KiB cap, threaded through both `multiplexPort` calls. Measured: the 10 MiB body becomes **160 chunks / 325 frames** capped against **1 chunk / 7 frames** unlimited |

Defects 1, 4 and 5 share a shape: the plan named an interface it had not read. Defect 2 is Plan A
finding 6 for the fourth time (absolute counts go stale; per-task deltas would survive). Defect 8 is
the good case — a reviewer's Important that was answered by adding a run rather than by softening a
sentence.

**One defect that is this document's own to report:** the spec's `PortMux` interface block still
carries "Layer 2 chunks to it (D10)" after D10 itself was corrected two hundred lines above it. Not
fixed here — this task's deliverables are the README, the changeset and this file — and named for C3
alongside `port-types.ts`.

---

## Deferred minors, recorded so they are not rediscovered

- **`msgpackCodec.read` can throw for three inputs**, all in the byte-shape check that runs *before*
  the `try`: a detached `ArrayBuffer`, a `DataView` over a detached buffer, and a `Proxy` with a
  throwing `getPrototypeOf`. None is producible by a remote peer — each needs same-process
  JavaScript already holding the backing memory. A reviewer threw 200k-deep nesting, a
  4-billion-entry map header, huge `bin32`/`str32` length claims, SAB-backed views,
  `Symbol`/`BigInt`/function-valued/null-prototype objects and a throwing getter at it; all returned
  `undefined`. So "cannot throw for any input" is **false literally and true for the threat model**,
  and no guard was added for the three, because a guard would imply a reachability that does not
  exist.
- **`serialize` returns an untrimmed view.** A 10 MiB envelope is a ~10,485,800-byte view over a
  **16,777,216-byte** `ArrayBuffer` (~1.6× slack, `byteOffset` 0). `post` ~6 ms, `read` ~0.2 ms,
  ~16 MB heap+external. A pump that sends `frame.buffer` instead of the view puts ~6 MiB of zeros on
  the wire per message. The conformance pipe sends the view; measured largest frame ~10,485,88x B,
  not 16,777,216. Now in the README.
- **`@ygoe/msgpack` logs before it throws.** On a truncation that runs off the end *where a byte code
  is expected*, `deserialize` calls `console.debug("msgpack array:", …)` with the whole buffer. A
  truncation landing mid-string throws `Cannot read properties of undefined (reading 'toString')`
  with no log; `0xc1` garbage and empty input throw silently. The codec catches the throw and cannot
  suppress the log. In the README so nobody debugs it twice.
- **`send.ts`, `call-bidi.ts` and `listen-bidi.ts`** also call `callPort`/`listenPort` directly but
  sit outside the equivalence file's header-comment scope. `send.ts` passes a **raw** (unserialized)
  `Error` where `duplex-over-port.ts` passes `serializeError(error)` — structurally the same
  envelope, but it means the raw-`Error` path is exercised by no D16 fixture. Predates this plan.
- **The unlimited conformance run's name** is only implicitly the unlimited one, by contrast with the
  capped one beside it. "frames unlimited" would make the reporter output self-describing.
- **The bench's `.slice()`** in the inbound pump is an uninvestigated cost driver, so the 64 KiB
  spread is unexplained; and the harness always runs direct before bridged in-process, so warm-up
  could flatter bridged.
- **L5 "idempotent serve teardown" puts no byte on the wire.** It is green against a codec that
  decodes nothing and against one that misroutes everything (rows 10–11). Of the 11 conformance
  tests, **10 are load-bearing on the byte path and 1 is not** — a property of that assertion, not of
  this pair; it survives the same mutations in every adapter.
- **L6 on this stack is an integrity check, nothing more.** The pair ignores `PairTuning`; there is
  no credit window to shrink. Unlimited, the 256 KiB body crosses as **one** application chunk (4
  chunks / 13 frames under the 64 KiB cap). Do not cite it as flow-control coverage — that lives in
  `webrun-rpc`'s `duplex-over-port-timeout` and `duplex-over-port-hostile` suites. This restates B2's
  finding for the new run.

---

## For Plan C2

**The framing margin is the first thing to write into the adapters.** `maxMessageSize` bounds the
payload; the envelope and codec framing ride on top, at 124–126 bytes measured and 134 modelled
worst-case. **Set `maxMessageSize` to `limit - 256`, not to `limit`.** Measured overruns at the two
real ceilings: 16 KiB → 16,508 B, 12 KiB → 12,413 B. Until D10's fix lands (C3), this margin is the
whole defence, and the transport that punishes getting it wrong does so silently.

**The bridge cost, and the decision it feeds.** Small messages: a real and consistent **1.14–1.51×**
(≈12–20 µs per round trip). Large bodies: **inconclusive, 0.89–1.35×, including bridged being
faster**. Node only. Option A (a real, transferable `MessagePort`) and Option B (a plain,
non-transferable `MessageTarget`) are laid out above with the numbers; **the choice is the human
partner's, and C2 should not read a decision into this document that is not there.** If the browser
number matters — and workers and iframes are a browser concept first — it is unmeasured and needs
its own run.

**Known ceilings, from the code:**

| adapter | ceiling | where |
| --- | --- | --- |
| `-webrtc` | **16 KiB** | `duplex-over-data-channel.ts:12`, `DC_MTU = 16 * 1024` ("conservative across browsers") |
| `-livekit` | **12 KiB** | `connect-serve.ts:24`, `LIVEKIT_SAFE_MTU = 12 * 1024` |
| `-peerjs` | **still unmeasured** | see below |

**`-peerjs`'s message ceiling must be measured before that adapter migrates.** It declares no MTU of
its own: `connect-serve.ts` forwards `mux` tuning straight to `emulateMux`, which chunks at
`DEFAULT_MTU = 64 * 1024` unless told otherwise. **That silent chunking disappears with
`emulateMux`.** Whatever PeerJS's real per-message limit is, nothing in this repo records it, and
the identical mistake on LiveKit delivered a 1 MiB body as **zero bytes with no error on either
side**. Measure it first; do not infer it from WebRTC's 16 KiB.

**What C1 hands over, precisely.** `multiplexPort` + `duplexOverPort` + `msgpackCodec` pass the
**unmodified** L0–L6 suite over a transport that carries bytes and refuses anything else, in **both**
framing regimes, with a 10 MiB body arriving whole rather than as zero bytes. So an adapter failure
in C2 is the adapter's transport, not the stack.

**What C1 does not establish, and C2 exists to.** The pipe is in-process, ordered, lossless, never
disconnects mid-stream and imposes no limit of its own — the 64 KiB cap is a number the *test* chose,
not one a transport enforced. A WebSocket's close codes, an `RTCDataChannel`'s hard cap and
`bufferedAmount` backpressure, LiveKit's packet sizes and reliability modes are all untested here.

---

## For Plan C3

- **`packages/webrun-rpc/src/port-types.ts:53-56` still says "Layer 1 does not enforce it; it
  reports it so layer 2 can chunk to fit."** That is false in exactly the way D10 was, and it sits in
  the API's own doc comment, where the next adapter author reads it. Two ways to make the name true:
  correct the comment, or have layer 2 reserve the framing budget — the codec advertising its own
  overhead — so the limit means the *frame*. **And the spec's own `PortMux` interface block carries
  the same sentence**, below the correction; fix both or the next reader finds the stale one.
- **No conformance level is sensitive to layer 1's `close`.** Dropping every inbound layer-1 `close`
  envelope leaves the byte-pipe suite 11/11 and — re-measured across the repo for this document —
  leaves all 84 `webrun-msgpack` tests and both `webrun-rpc` conformance runs green. The only test
  anywhere that notices is `webrun-rpc`'s own id-retirement churn test. C3 is the plan that reopens
  the suite (D17's L6 redefinition), so it is the place to decide whether a level should observe a
  port close at all.
- **`serializeError` (`packages/webrun-streams/src/errors.ts:7-13`) copies every own enumerable
  property off a thrown `Error` onto the wire, unfiltered.** So whether the `error` payload is
  msgpack-expressible **depends on what application code throws** — a `cause` holding a `Map`, a
  class instance, a circular reference. Invisible over `structuredCodec`; over bytes it collapses to
  `{}` or makes `serialize` throw. No fixture in `codec-equivalence.test.ts` can pin it, because the
  input is the application's. This is a question about D16's *reach* (does D16 bind
  `serializeError`'s output, and if so how is it enforced?), not a codec defect.
- **`ByteChannel` is a public type across `webrun-streams-signaling`** — 8 source files
  (`byte-channel.ts`, `byte-queue.ts`, `peer-connection.ts`, `peer-manager.ts`, `qr-signaling.ts`,
  `room-manager.ts`, `types.ts`, `index.ts`) and 3 test files. B2's deletion list puts `ByteChannel`
  on C3's block; this consumer must be **decided about rather than discovered** partway through the
  deletion.
- **`typecheck:tests` has an unenforced build dependency** in two packages now (`webrun-rpc`,
  `webrun-msgpack`), because `turbo.json` declares no `typecheck*` task. A fresh clone gets `TS2307`.
- **Still owed from B2, unchanged by this plan:** D17's L6 redefinition and the `PairTuning` reshape;
  D14's shared control port (the `{kind}` discriminator is passed through `meta` today and inspected
  by nobody); D23's send-only `MessageSink` entry point; `transferPortMux`'s unbounded `issued` set;
  the `emulateMux` deletion and its blast radius.
