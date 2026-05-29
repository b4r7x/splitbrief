# Decisions

Several audit "fixes" are **decisions, not mechanics**. If different implementers
decide them independently the codebase ends up inconsistent. They are decided here
once; briefs **reference** these, they do not re-decide. Each has a recommendation
(the default the implementer applies) and the rationale.

---

## D1 — Unsafe-assertion enforcement: invariants grep gate (not per-file Biome overrides)

**Decision:** Re-enable the *intent* of "no unsafe assertions" via a **grep gate in
`scripts/check-invariants.ts`**, not via Biome `overrides`. Keep Biome's
`noNonNullAssertion`/`noExplicitAny` as-is or turn on with a broad allow, but the
authoritative gate is the invariants script that greps `src/` for incidental `!`,
broad `as`, and `any`, allow-listing exactly the sanctioned sites already named in
CLAUDE.md.

**Why:** CLAUDE.md already enumerates the sanctioned exception list as prose; an
invariants grep is the existing mechanism (`npm run check:invariants`) and keeps the
allow-list in one reviewable place. Per-file Biome `overrides` would scatter the
same list across config and drift from CLAUDE.md. (Audit TS-02.)

**Owner:** B02. **Affects:** `scripts/check-invariants.ts`, `biome.json`, the 4 stray
`!` and ~30 broad `as`.

---

## D2 — Error subclasses are the one sanctioned `class`

**Decision:** `class CliError extends Error` (and any other `X extends Error`) is
**permitted**, overriding "zero classes" for error types only. Convert
`Object.assign(new Error(), {exitCode})` → `class CliError extends Error`;
`isCliError` → `instanceof CliError`.

**Why:** Constitution IV says zero classes, but error subclassing is idiomatic,
needs no `this`-heavy logic, and the audit (EH row) explicitly recommends it; the
existing `Object.assign` pattern is worse (untyped, unguardable). Scope the exception
to `extends Error` only — no other class hierarchies.

**Owner:** B05. **Affects:** `cli/errors.ts`.

---

## D3 — Single JSON/JSONL "persisted store unreadable" policy

**Decision:** All persisted-store readers (`core/stats/persistence.ts`,
`core/state/persistence.ts`, `core/sessions/{io,tree/io}.ts`, `engine/ipc/replay.ts`)
follow **one** policy:

- **Missing file** → return the empty/default value (no warn).
- **Present but unparseable/invalid** → `warnError(...)` once, then return the empty/
  default value. Do **not** throw, do **not** silently swallow.

The exception is security-/integrity-critical reads (snapshot manifests) which must
**throw** — corruption there is not recoverable and must surface.

**Why:** The audit (EH "three ways", DRY "JSONL readers 3×") shows divergent
throw/warn/silent handling. Resilient-with-a-warning is correct for telemetry/UI
state (a corrupt stats file must not crash a session); throw-on-corruption is correct
only where the data gates correctness. Collapse the internally-dead
`if (isENOENT) return empty; return empty;` branch in `readStats`.

**Owner:** B05 (policy + `lib/fs.ts` helpers `readValidatedJson`/`readJsonl`); B12/B13
route the duplicate readers through the helpers.

---

## D4 — Spawn contract: all propagate (throw)

**Decision:** The `lib/process/spawn.ts` trio is made **consistent on throwing**:
`runCommand`/`spawnWithTimeout`/`spawnWithStdin` all reject/throw on non-zero/127.
Callers that want the code inspect the thrown structured error. Do **not** keep the
current split (two return `{code}`, one throws).

**Why:** The audit (EH spawn row) flags the silent divergence as a footgun
(`spawnWithStdin` throws unsignaled by name). One contract is safer than a rename.
Boundary callers already catch; interior callers propagate (Constitution IV).

**Owner:** B05. **Affects:** `lib/process/spawn.ts` + its callers.

**Behavior note:** this changes the failure *mode* of `runCommand`/`spawnWithTimeout`
callers from "inspect `.code`" to "catch". Implementer must update every call site and
add/adjust tests. If any caller relied on a non-throwing `{code}` for control flow,
preserve that behavior at the call site with a local try/catch — do not weaken the
contract back.

---

## D5 — `computeScrollWindow` contract: it is a CAP (rename the floor away)

**Decision:** `computeScrollWindow`/`maxVisible` must behave as a **cap** (`Math.min`
on visible rows), matching what session/skills pickers pass `maxVisible={5}`
expecting. Fix the implementation to cap, keep the name `maxVisible`.

**Why:** Audit NM-01 (high): today `maxVisible` is used as a *floor*, so pickers get
28 rows on a tall terminal — the opposite of the prop's name and the caller's intent.
This is a **behavior change visible in the TUI** (pickers will show ≤5 rows as
intended). It is a bugfix toward documented intent, not a regression.

**Owner:** B08 (owns `picker-utils.ts`/`scroll-window.ts`). Pickers verified after.

---

## D6 — The lone facade: keep one, delete the abandoned one

**Decision:** Delete `engine/facades/recovery.ts` (the one-subsystem facade nobody
adopted) **and** establish exactly one *new* intentional facade:
`engine/facades/routing-preview.ts`, consumed by the 3 UI sites that currently re-run
engine packet/route assembly through deep imports. Net: facades exist where they earn
their keep (a real cross-cutting UI→engine boundary), not as a vestige.

**Why:** Audit AR rows: "facade applied to exactly one subsystem and abandoned" +
"3 UI sites re-run engine assembly with no facade." The principled resolution is to
remove the dead pattern and add the one the codebase actually needs.

**Owner:** B09. **Affects:** `engine/facades/recovery.ts` (delete; inline its 1 caller),
new `engine/facades/routing-preview.ts`, `worker-packet-preview.ts`,
`components/brief-review.ts`, `plan-editor/preview-panel.tsx`.

---

## D7 — `core/layout/` relocates above `engine/` → `LayoutEvent` mirror is deleted

**Decision:** Relocate the whole `core/layout/` tree to a UI-adjacent home
(recommended: `src/features/workflow/layout/`, since every importer is UI). Once it
may import `engine/`, **delete `core/layout/event-types.ts`'s hand-mirrored
`LayoutEvent`** and use `EngineEvent` directly.

**Why:** Audit AR/FO highs: all `core/layout` files are imported only by UI, and the
77-literal `LayoutEvent` mirror exists *solely* because `core/` cannot import
`engine/`. Relocating dissolves both the layering inversion and the mirror.

**Owner:** B09. **Coordination:** B03 (schema single-sourcing) must **not** touch
`LayoutEvent` — it is deleted here, not single-sourced.

---

## D8 — `predictCost` gets the model cache (and `getProviderPricing` is deleted)

**Decision:** Thread `wctx.modelCache` into `predictCost`; delete the
`getProviderPricing` param-reordering pass-through that drops the cache.

**Why:** Audit AR high: the bracketed prediction can never see live models.dev pricing
while the sibling deterministic estimate does, so the two cost surfaces shown together
disagree. **Behavior change:** predicted cost will now reflect live pricing (matching
the other surface) — intended.

**Owner:** B09. **Affects:** `budget/cost-prediction.ts`, `providers/pricing.ts`.

---

## D9 — `providers/pricing.ts` renames to `cost.ts`

**Decision:** Rename `engine/providers/pricing.ts` → `engine/providers/cost.ts` (it
contains all cost math, zero pricing; the real pricing source is `pricing-resolver.ts`).
Update all importers' `.js` paths.

**Why:** Audit NM/SRP: the filename actively misleads. Do the rename as part of the SRP
split (`cost-math.ts` etc.), not separately, so importers churn once.

**Owner:** B10. **Coordination:** B07 changes signatures *inside* this file
(`calculateUsageCost` family) **before** B10 renames/splits it — B10 rebases onto B07's
signatures.

---

## D10 — Brief contract strings are single-sourced as exported constants

**Decision:** Introduce `TASK_BRIEF_HEADINGS` (and `REQUIRED_BRIEF_SECTIONS`) as the
one source of truth for the Task-Brief round-trip contract, consumed by writer,
parser, prompt-formatter, and examples. Prompt prose that enumerates sections
references the constant's values.

**Why:** Audit DRY highs: the round-trip contract is currently held by string literals
in 4+ files; drift silently breaks parse. Single-sourcing is mandatory, not optional.

**Owner:** B12. **Coordination:** depends on no other brief; do early within wave 7.

---

## D11 — Deleting `branch-summary`/`reconstruct` MOOTS their DRY finding

**Decision:** B14 deletes the two fully-dead session-tree subsystems
(`branch-summary.ts`, `summary-prompt.ts`, `branch-context.ts`, `reconstruct.ts`,
~500 LOC incl. tests). The audit's "4 JSON-extractor parsers" DRY finding (DRY row
re: `branch-summary.ts:11`) is therefore **reduced to 3** extractors. The
`utils/extract-json-block.ts` helper (B04/B12) is built for the *remaining* 3.

**Why:** Avoid double-counting: do not flag "you didn't dedupe the branch-summary
extractor" against B12 — its file is gone. Traceability marks that sub-item
**MOOTED-BY-B14**.

**Owner:** note for validators of B12 and B14.

---

## D12 — `pluralize` and other "tested-but-unused" helpers are ADOPTED, not deleted

**Decision:** Where the audit lists a helper as both "dead export" (Dead Code) and
"should be adopted everywhere" (DRY/Reusability) — `pluralize` is the canonical case —
the resolution is **adopt**, not delete. It stops being dead once adopted.

**Why:** Two audit rows point opposite directions for the same symbol; adoption
satisfies both (it is no longer unused, and the 28 inline copies collapse).

**Owner:** B12/B13 (adoption). **Coordination:** B14 (dead code) must **not** delete
`pluralize`, `clamp`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`, or any
symbol B04 promoted for adoption. Traceability flags these **ADOPT-NOT-DELETE**.

---

## D13 — Validation is unbiased and re-derives from code

**Decision:** Every validator agent is spawned **fresh** (no implementer transcript),
receives **(a)** its brief's finding rows, **(b)** the actual `git diff` of the
working tree, **(c)** the repo conventions — and must re-derive, per finding, whether
it is addressed *in the code*, not whether the implementer said so. It must also run
`typecheck` + `lint` + the brief's affected tests itself and report regressions and any
newly-introduced slop. Verdict is structured (see `validation/validator-protocol.md`).
A finding the validator cannot confirm in the diff is a **GAP**, not a pass.

**Why:** The user's binding requirement ("nothing gets silently dropped") and
Constitution V. A self-report is not evidence.

**Owner:** all waves.
