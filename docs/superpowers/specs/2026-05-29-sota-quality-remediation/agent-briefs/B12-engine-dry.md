# B12 — Engine DRY extractions & adoption

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Collapse the engine-side duplication that the audit found: extract a handful of new
shared helpers, single-source the Task-Brief heading/section contract (D10), and adopt
the helpers B04 already promoted (`pluralize`, `formatPercent`, `formatKnownCost`,
`formatTruncatedList`, `formatTaskId`, `isTerminalPhase`, `isTaskCompleted`,
`extractJsonBlock`, `escapeRegExp`) plus pre-existing utilities (`isRecord`,
`countBySeverity`, `extractFrontmatter`, `createLineBuffer`, `emptyActiveChain`,
`DIPTYCH_DIR`) across the engine tree. After this brief each duplicated concept has one
definition, all engine call sites route through it, and the codebase still
typechecks/lints/tests green with **no observable behavior change** (the few
behavior-sensitive sites are flagged explicitly below).

## Wave / ordering

- **Wave:** 7. **Runs after:** B04 (the producer wave — every helper this brief adopts
  must already exist + be exported in its canonical home) and B10 (engine SRP file
  splits + the `pricing.ts`→`cost.ts` rename, D9). It also lands after B02/B06/B07/B08/B09
  which re-signatured, moved, and split many of these exact files.
- **CRITICAL — anchors are pre-remediation.** Every `file:line` below is from the
  original audit against the *pre-remediation* tree. By wave 7 the file may have been
  **moved, split, or re-signatured** by an earlier wave. **Locate every target by
  symbol/grep against the CURRENT working tree, not by line number**, and edit the
  **post-refactor** home. Known relocations you will hit:
  - `engine/providers/pricing.ts` → **`engine/providers/cost.ts`** (B10/D9), with the
    `calculateUsageCost` family already converted to options objects by B07. Used by
    DRY-56.
  - `engine/streaming/output-parsers.ts` → **split per-format** (B10/SRP-06), dispatcher
    kept. Used by DRY-55.
  - `engine/orchestrator/planning/shared.ts` → **split into ~3 modules** (B10/SRP-02) +
    B06 param objects. Used by DRY-05.
  - `engine/orchestrator/evidence/ledger.ts` → **relocated to `core/evidence/ledger.ts`**
    (B09/AR-04). Used by DRY-35, DRY-51, RU-04.
  - `engine/orchestrator/evidence/review-packet/{sections,build}.ts` → **split**
    (B10/SRP-08, new `sections-io.ts`/`artifacts.ts`). Used by DRY-22, DRY-51.
  - `engine/orchestrator/planner-estimate-review.ts` → **parser extracted** to
    `estimate-review-parser.ts` (B10/SRP-15). Used by DRY-30.
  - If a relocation listed here has **not** in fact landed (a sibling brief slipped),
    fall back to the original path; the rule is "edit wherever the symbol actually lives
    now."
- **Decisions that bind this brief:**
  - **D10** — `TASK_BRIEF_HEADINGS` and `REQUIRED_BRIEF_SECTIONS` are the single source
    of truth for the Task-Brief round-trip contract, consumed by writer, parser,
    prompt-formatter, and the prompt examples. Owner: **B12**. Do D10 (DRY-11/25/26)
    **first** within this brief — it is independent of the other rows.
  - **D11** — the 4th JSON-extractor (`sessions/tree/branch-summary.ts`) is deleted by
    B14, so DRY-30 is reduced to **3** sites (`speckit.ts` already done by B04;
    you adopt in `estimate-review-parser`/`planner-estimate-review.ts` and
    `parsers/question-parser.ts`). Do **not** chase `branch-summary.ts`.
  - **D12** — `pluralize`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`, and
    every B04-promoted symbol are **ADOPT-NOT-DELETE**. Adopting them here is the point;
    B14 must not delete them. Do not mark any as dead.

## File ownership

You **edit** (engine adoption + new helpers). Build on the post-B0x state; never revert
prior briefs' edits.

**Create (new shared helpers — verify each does not already exist before creating):**

- `src/engine/orchestrator/approval/gate-and-promote.ts` — `gateAndPromoteChangedFiles`
  (DRY-03).
- `src/engine/spec/headings.ts` — `TASK_BRIEF_HEADINGS`, `REQUIRED_BRIEF_SECTIONS`
  (D10 / DRY-11, DRY-25).
- A `fenced(body, lang?)` helper for prompts (DRY-26): add to
  `src/engine/spec/prompts/shared.ts` (already exists; it is **not** a barrel — it holds
  real prompt helpers).
- `src/engine/providers/usage.ts` — `parsePartialUsage`, `buildPricingFields` (DRY-28).
  > If a more natural home already exists post-B10 (e.g. a providers `metadata.ts`/
  > `cost.ts`), put them there instead of inventing a file; do not create a barrel.
- Add `countByValue<T, K extends string>(...)` to `src/utils/collections.ts` (DRY-52).
- Add `STREAM_IDLE_TIMEOUT_MESSAGE` to `src/engine/constants.ts` next to
  `STREAM_IDLE_TIMEOUT_MS` (DRY-55).
- `getOrCreateLedger(...)` — add to the (post-B09) `src/core/evidence/ledger.ts`
  (DRY-35).
- `firstBriefErrorMessage(report)` — add next to the brief-quality report type
  (`src/engine/spec/brief-quality.ts`) (DRY-05).
- `configForProfile(config, profile)` — one definition (see step for DRY-37).
- `bindPlannerToProjectDir(planner, projectDir)` — in
  `src/engine/orchestrator/transcript-rebuild.ts` (DRY-36).
- `toRejectedProfile(profileFit, selected?)` — in
  `src/engine/orchestrator/context-routing/route.ts` (DRY-54).
- `failedRetry(attempts)` — in `src/engine/orchestrator/escalation/types.ts` or a small
  shared module reachable by `step.ts`/`escalation.ts`/`run-escalation-tier.ts` (DRY-53).
- `buildTaskListSection(tasks)` — in `src/engine/handoff/renderers/shared.ts` (DRY-77).
- `renderSectionLines(section)` — in `src/core/readiness/format.ts` (DRY-44).
- `readReadinessArtifact(...)` + `isBriefQualityReport(...)` — co-located with the
  readiness/brief-quality readers (DRY-22).
- `mergeTaskActivity(...)` — in `src/engine/orchestrator/explain/sections.ts` (DRY-27).
- Move `RecoveryFact` accessors (`factString`/`factNumber`/`factBoolean`) next to the
  `RecoveryFact` type in `src/core/schemas/recovery.ts` (RU-16).

**Edit (adopt helpers / dedupe — engine sites):** `escalation/step.ts`,
`task/apply-changed-files.ts`, `planning/shared.ts` (or its post-B10 split),
`planning/instant.ts`, `planning/quick.ts`, `run/phases.ts`, `spec/formatter.ts`,
`spec/prompt-formatter.ts`, `spec/parser.ts`, `spec/prompts/{instant,quick-plan,tasks,
escalation,review,estimate-review}.ts`, `user-edit/detection.ts`, `core/state/machine.ts`,
the (post-B09) `core/evidence/ledger.ts` + `evidence/review-packet/{sections,build}.ts`
(or their post-B10 split) + `evidence/task-evidence.ts` + `evidence/reporting.ts`,
`explain/sections.ts`, `providers/anthropic/stream.ts`, `providers/models-dev.ts`,
`providers/openrouter.ts`, `core/providers/known-models.ts`, `engine/orchestrator/
planner-estimate-review.ts` (or its post-B10 parser), `parsers/question-parser.ts`,
`handoff/renderers/{shared,agents-md,claude-code}.ts`, `recovery/actions.ts`,
`recovery-prompt.ts` (UI — see note), `resume-context.ts`, `transcript-rebuild.ts`,
`task/routing.ts`, `escalation/retry-runtime.ts`, `task/loop.ts`, `core/project-meta.ts`,
`budget/estimate.ts`, `escalation/escalation.ts`, `escalation/run-escalation-tier.ts`,
`context-routing/route.ts`, `streaming/output-parsers.ts` (or its post-B10 split),
`engine/agent-sdk-backend.ts`, `task/streaming-feed.ts`, `drift/chain.ts`, `drift/drift.ts`,
`worktree.ts`, the DRY-66 prompt files (UI — see note), all engine `.diptych` literal
sites (DRY-59a), engine `escapeRegExp` adopters (`planners/cli.ts`, `codebase/repomap.ts`,
`parsers/scope-extractor.ts`).

**Note — three findings own UI (`src/features/workflow/…`) files, by design.** The
"Engine DRY" title is loose; the traceability + Coverage-summary B12 line assign these to
B12:
- **DRY-66** `formatTruncatedList` adoption: `features/workflow/task-review-prompt.ts`,
  `features/workflow/user-edit-conflict-prompt.ts`, `features/workflow/recovery-prompt.ts`,
  `features/workflow/conversation-rows/event-format.ts`.
- **RU-16** `RecoveryFact` accessors: the engine side `recovery/actions.ts` **and** the UI
  side `features/workflow/recovery-prompt.ts` (both import the moved accessors from
  `core/schemas/recovery.ts`).
No collision-map row touches those UI files, so you are the sole owner. (B04's prose
loosely says "B13" for DRY-66 — that is an informal aside in another brief; the
authoritative sources, traceability row 200 + Coverage line for B12, say B12. Take it.)

**Collision-map files (serialized — build on the prior brief, never revert):**
- `core/state/machine.ts` — order **B02 → B08 → B12**. B02 added the `default:
  assertNever(action)`; B08 gave `transition` a trailing `opts?`. **You own** only
  `rewindReset`/`resetToIdle` extraction + the REWIND/idle dedup (DRY-18, DRY-67).
  Preserve the `assertNever` default and B08's signature exactly.
- `engine/orchestrator/evidence/{ledger,persistence}.ts` — order **B06 → B09 → B12**.
  B06 gave `persistence` param objects; **B09 relocated `ledger.ts` to
  `core/evidence/ledger.ts`** and deduped `recomputeValidationSummary`. **You own** only
  the shared selectors + `getOrCreateLedger` + `uniquePush<T>` move (DRY-35, DRY-51,
  RU-04). Edit the file at its **post-B09 home**.

## Findings covered

All anchors are pre-remediation; locate by symbol against the current tree.

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| DRY-03 | high | `escalation/step.ts:55-130` + `task/apply-changed-files.ts:37-113` (+`validate-and-commit.ts:40-89` → **B14 deletes; do NOT touch**) | Extract `gateAndPromoteChangedFiles(opts)` from the **two live** sites; the helper owns the capture-before-gate ordering once. |
| DRY-05 | high | `planning/shared.ts:211,289` + `instant.ts` + `quick.ts` + `run/phases.ts` | Add `firstBriefErrorMessage(report)`; route all 4 sites through it. |
| DRY-08a | high | `utils/format.ts:1` (`pluralize`) — engine inline copies | Adopt `pluralize` at engine ternary-pluralization sites (D12). Grep `src/engine`; if none remain, PASS-by-absence. |
| DRY-11 | high | `engine/spec/formatter.ts:40-110` | Single-source the `### …` headings as `TASK_BRIEF_HEADINGS`; writer (`formatter.ts`, `prompt-formatter.ts`) emits from it; parser (`parser.ts`) derives its primary keys from it **without losing aliases** (D10). |
| DRY-17 | high | `engine/orchestrator/user-edit/detection.ts:87-104` | Name the fallback-conflict `availableActions` const; extract the shared "prompt + SET_PENDING_RECOVERY + publishRecoveryPrompted + setTrackedState" tail. |
| DRY-18 | high | `core/state/machine.ts:284-314` | `rewindReset(state, target, comment?)`; `REWIND_TO_SPEC`/`REWIND_TO_PLAN` call it. |
| DRY-22 | high | `evidence/review-packet/build.ts:116-191` | Shared `readReadinessArtifact(...)`; `isBriefQualityReport(...)` type guard. |
| DRY-25 | med | `spec/prompts/{instant,quick-plan,tasks}.ts` | `REQUIRED_BRIEF_SECTIONS` (D10); prompt prose references the constant's values. |
| DRY-26 | med | `spec/prompts/{escalation,review,estimate-review}.ts` | `fenced(body, lang?)` for the ```` ```lang\n…\n``` ```` wrapping. |
| DRY-27 | med | `engine/orchestrator/explain/sections.ts:138-237` | Adopt `formatKnownCost` (B04, core) for the `${cost} + unknown` labels; extract `mergeTaskActivity(...)` for the `taskStatusActivity`/`skippedActivity` map-merge. |
| DRY-28 | med | `anthropic/stream.ts` + `models-dev.ts` + `openrouter.ts` | `parsePartialUsage` (token fields) + `buildPricingFields` (pricingInput/Output); route the three sites through them. **Behavior-preserving.** |
| DRY-29 | med | `core/providers/known-models.ts:110-155` | Hoist `CLAUDE_*_PRICING` consts to module scope; reference them. |
| DRY-30 | med | `planner-estimate-review.ts` + `parsers/question-parser.ts` (branch-summary → `[M]` B14) | Adopt `utils/extract-json-block.ts` (B04) at the **3** remaining sites (`speckit.ts` already done by B04). **Behavior-sensitive — see step.** |
| DRY-31 | med | `engine/handoff/renderers/shared.ts:9-80` | Reuse `buildScopeLines` (in `spec/formatter.ts`) + `listOrNone` for the in/out-of-bounds and escalation/evidence lists in `formatTaskBrief`. |
| DRY-32 | med | `engine/export/collect.ts` + `evidence/reporting.ts` + `spec/brief-quality.ts` | Adopt the existing `buildEvidenceSummary` (`evidence/reporting.ts`) in `collect.ts`; use `countBySeverity` (`utils/collections.ts`) for the error/warning counts. |
| DRY-35 | med | `engine/orchestrator/recovery/actions.ts:379-387` | Add `getOrCreateLedger(...)` to `core/evidence/ledger.ts`; `recordRecoverySkipEvidence` calls it. |
| DRY-36 | med | `resume-context.ts:42-47` + `transcript-rebuild.ts:72-77` | `bindPlannerToProjectDir(planner, projectDir)` returning the `{summarize, summarizeStructured?}` adapter; both sites use it. |
| DRY-37 | med | `task/routing.ts` + `escalation/retry-runtime.ts` + `task/loop.ts` | One `configForProfile`; replace `taskConfigForProfile`/`retryConfigForProfile` duplicates. (`stateForRetryProfile` already single-sourced — leave.) |
| DRY-40 | med | `core/project-meta.ts:12,29,30` | Import `isRecord` (`utils/type-guards.ts`); replace inline object checks + the `as Record` cast. |
| DRY-44 | med | `core/readiness/format.ts:22-58` | `renderSectionLines(section)`; both `formatReadinessReport` and `formatReadinessBlockers` call it. |
| DRY-51 | med | `core/evidence/ledger.ts` + `evidence/review-packet/sections.ts` | Shared task-status-count selectors; adopt the existing `extractFrontmatter` (`utils/frontmatter.ts`) for inline frontmatter parsing. |
| DRY-52 | low | `engine/orchestrator/budget/estimate.ts:200-225` | `countByValue` (generic); replace `fitCounts`/`contextConfidenceCounts`/`priceConfidenceCounts`. |
| DRY-53 | low | `escalation/escalation.ts` (12 sites) | `failedRetry(attempts)` returning `{ completed: false, method: 'failed', attempts }`; adopt across `escalation.ts`/`step.ts`/`run-escalation-tier.ts`. |
| DRY-54 | low | `context-routing/route.ts:13-72` | `toRejectedProfile(profileFit, selected?)`; both `rejected` `.map(...)` blocks call it. |
| DRY-55 | low | `output-parsers.ts:159` + `anthropic/stream.ts:266` | `STREAM_IDLE_TIMEOUT_MESSAGE` const in `engine/constants.ts`; both sites reference it. |
| DRY-56 | low | `agent-sdk-backend.ts:100,114` + `pricing.ts:47` | `Pick<TokenDelta, 'inputTokens' \| 'outputTokens'>` (or one exported `TokenSplit`) for the three inline shapes. (`pricing.ts`→`cost.ts` post-B10.) |
| DRY-58 | low | `task/streaming-feed.ts:33-40` | Drive line-splitting via `createLineBuffer` (`lib/process/line-buffer.ts`); **preserve** the `>20`-char partial-line flush exactly. |
| DRY-59a | med | `.diptych` literal — engine sites | Replace `'.diptych'` literals with `DIPTYCH_DIR` (`core/paths.ts`); reuse existing path helpers where present. |
| DRY-61 | low | `drift/chain.ts:69` | Import `emptyActiveChain()` (`drift/chain-state.ts`); drop the inline empty-chain literal. |
| DRY-66 | med | `task-review-prompt.ts` + `user-edit-conflict-prompt.ts` + `recovery-prompt.ts` + `event-format.ts` (UI) | Adopt `formatTruncatedList` (B04, `core/formatting.ts`) at the four `values.slice(0,max)…+N more` copies. |
| DRY-67 | low | `core/state/machine.ts:175-273` | `resetToIdle(state, opts?)`; the idle-reset cases (`REJECT_SPEC`/`REJECT_PLAN`/`REJECT_BRIEFS`/`CONSTITUTION_CHECK_FAIL`/`CANCEL`) call it; reuse `stripCurrentCode` where applicable. |
| DRY-77 | low | `engine/handoff/renderers/{agents-md,claude-code}.ts` | `buildTaskListSection(tasks)` returning the `## Tasks\n\n…` block; both renderers call it. (Config "load once" is PF-01/B16 — out of scope here.) |
| RU-04 | med | `evidence/task-evidence.ts:16` | Make `uniquePush` generic (`uniquePush<T>(arr: T[], value: T)`) and move to `utils/collections.ts`; update importers. |
| RU-16 | low | `recovery-prompt.ts:174-184` + `recovery/actions.ts:413-423` | Move `RecoveryFact` accessors (`factString`/`factNumber`/`factBoolean`) next to `RecoveryFact` in `core/schemas/recovery.ts`; both sites import them. |

**Engine adoption with no standalone B12 ID (coordinator B12 scope line + D12 — do not
drop these):** the coordinator groups `pluralize`/`formatPercent`/`isTerminalPhase`/
`isTaskCompleted` as engine adoptions owned by B12. Adopt:
- `isTerminalPhase` (`core/phases.ts`) at `engine/worktree.ts` (the two
  `phase === 'complete' || phase === 'idle'` sites).
- `isTaskCompleted` (`core/schemas/task.ts`) at `drift/drift.ts` (replace the local
  `isCompleted`), `recovery/actions.ts` (the `task.status === 'done' || task.status ===
  'escalated'` guard), and `task/loop.ts` (the `done || escalated` guard). Leave
  `=== 'complete'`-only and `=== 'done'`-only predicates untouched.
- `formatPercent` (`core/formatting.ts`, B04) — see Step 27b.
- `pluralize` (`utils/format.ts`) — see Step 27a.
- `escapeRegExp` (`utils/regexp.ts`, B04) at `planners/cli.ts`, `codebase/repomap.ts`,
  `parsers/scope-extractor.ts` (DRY-39 adoption side).

## Required changes

Use `.js` import extensions everywhere. No `!`/broad `as`/`any`/non-Error classes/
barrels/memoization. No decorative comments. Every change is **behavior-preserving**
unless the step says otherwise; the brief authorizes **no** observable behavior change.

### Step 0 — orient against the current tree

Before editing any file, `grep` for the symbol named in the row (not the line). For every
relocation in "Wave / ordering", confirm where the symbol lives now and edit there.

### Step 1 — D10: Task-Brief contract single-sourcing (DRY-11, DRY-25, DRY-26) — DO FIRST

The contract is held in two halves today:
- **Writer:** `spec/formatter.ts` emits `### Description`, `### Implementation Steps`,
  `### Tests`, `### Constraints`, `### Signature`, `### Current Code`,
  `### Type Definitions`, `### Pattern`, `### Scope`, `### Escalation`, `### Evidence`;
  `spec/prompt-formatter.ts` emits the same set (and `findCodeContextInsertIndex` lists a
  subset).
- **Parser:** `spec/parser.ts` `extractSections` lowercases headings and `readSection`
  looks them up **with aliases**: `('description','what to do')`,
  `('signature','function signature')`, `('type definitions','types')`,
  `('current code')`, etc.

1a. Create `src/engine/spec/headings.ts`. Make it a **structured** source so the writer
gets the `### X` strings and the parser gets primary keys **plus** their aliases — a flat
string list would silently break the parser aliases (the exact drift D10 exists to
prevent). For example:

```ts
export const TASK_BRIEF_HEADINGS = {
  description: { heading: '### Description', keys: ['description', 'what to do'] },
  signature: { heading: '### Signature', keys: ['signature', 'function signature'] },
  typeDefs: { heading: '### Type Definitions', keys: ['type definitions', 'types'] },
  pattern: { heading: '### Pattern', keys: ['pattern'] },
  implementationSteps: { heading: '### Implementation Steps', keys: ['implementation steps'] },
  tests: { heading: '### Tests', keys: ['tests'] },
  currentCode: { heading: '### Current Code', keys: ['current code'] },
  scope: { heading: '### Scope', keys: ['scope'] },
  escalation: { heading: '### Escalation', keys: ['escalation'] },
  evidence: { heading: '### Evidence', keys: ['evidence'] },
} as const;
```

> Match the **exact** current heading strings and the exact current alias lists — copy
> them from `parser.ts`'s `readSection(...)` calls and `formatter.ts`/`prompt-formatter.ts`'s
> literals. Do not add/remove/reorder any heading or alias.

1b. Rewire `spec/formatter.ts` `formatSingleTask` and `spec/prompt-formatter.ts`
`buildTaskSections`/`findCodeContextInsertIndex`/`insertCodeContext` to push
`TASK_BRIEF_HEADINGS.<x>.heading` instead of the literal `### …` strings. The emitted
output must be **byte-identical** (`formatter.test.ts` and any prompt-formatter test stay
green unchanged).

1c. Rewire `spec/parser.ts` `extractSections` so each `readSection(sectionMap, …)` call
passes `...TASK_BRIEF_HEADINGS.<x>.keys`. The lowercased lookup keys and alias fallbacks
must be unchanged (`parser.test.ts` stays green).

1d. **DRY-25** `REQUIRED_BRIEF_SECTIONS`: in `headings.ts` also export the section
contract — the ordered list `Description (Intent), Scope, Implementation Steps, Tests
(Validation), Constraints, Escalation, Evidence, Type Definitions`. Two distinct uses, do
not conflate them:
- `instant.ts:20` and `quick-plan.ts:26` enumerate this **section-name list** in prose
  ("Required per brief: …"). Replace those hand-written lists with prose that interpolates
  `REQUIRED_BRIEF_SECTIONS` (the joined names).
- `tasks.ts:9-14` references the **heading strings** themselves (`` `### Description` ``,
  `` `### Implementation Steps` ``, `` `### Tests` ``, `` `### Constraints` `` in prose) —
  point those at `TASK_BRIEF_HEADINGS.<x>.heading`, **not** `REQUIRED_BRIEF_SECTIONS`.
Keep the rendered prompt text equivalent (same sections/headings, same order; the prompt
tests, where present, must pass).

1e. **DRY-26** `fenced`: add to `spec/prompts/shared.ts`:

```ts
export function fenced(body: string, lang = ''): string {
  return '```' + lang + '\n' + body + '\n```';
}
```

Replace the inline ```` '```diff\n' + diff + '\n```' ````, ```` '```json\n' + … ````,
and ```` '```\n' + error + '\n```' ```` constructions in `prompts/review.ts`,
`prompts/estimate-review.ts`, and `prompts/escalation.ts` (two sites) with
`fenced(diff, 'diff')` / `fenced(JSON.stringify(packet, null, 2), 'json')` /
`fenced(error)` etc. **Byte-identical output.**

### Step 2 — DRY-03: `gateAndPromoteChangedFiles` (highest-risk extraction)

The two live sites are `escalation/step.ts` (lines ~55-130) and
`task/apply-changed-files.ts` (lines ~37-113). The third occurrence,
`escalation/validate-and-commit.ts:40-89` (the `if (preApprovedChangedFiles === undefined)`
branch), is **dead and deleted by B14 (DC-02)** — **do NOT touch `validate-and-commit.ts`**.

Both live sites perform the same skeleton, and the shared "capture-before-gate" ordering
**is** the race the dedup fixes — the helper must own it once:
1. resolve `changedFiles` (staged-vs-actual: prefer staged snapshot, fall back to project
   dir when staging yields none — track a `fromStaging` flag),
2. `captureCurrentFileContents(projectDir, changedFiles)` **before** gating,
3. `gateChangedFiles({...})` (post-B06 options shape),
4. on deny: when **not** from staging, `restoreDirtyFilesFromSnapshot(...)`, and on
   restore conflicts invoke the caller's conflict handler; then record the denial,
5. on allow: persist approval evidence, and when staged, `promoteStagedChanges(...)`
   reusing the **same** captured contents; on promote conflicts invoke the conflict
   handler.

The two sites differ — your options object must parametrize the differences:
- **which files to gate:** `apply-changed-files.ts` filters to
  `filesNeedingApproval = taskChangedFiles \ preApplyApprovedFiles` and only gates/
  persists when that set is non-empty; `step.ts` gates the full `actualChangedFiles`.
  Expose this via the options (e.g. `preApprovedFiles: string[]` defaulting to `[]`).
- **evidence fns:** `apply-changed-files.ts` uses `persistApprovalEvidence`; `step.ts`
  uses `persistRetryApprovalEvidence`/`persistRetryRejectionEvidence`. Pass these as
  callbacks (e.g. `onApproved(gate)`, `onDenied(gate)`).
- **denial reporting:** `apply-changed-files.ts` calls `recordApprovalDenial(...)` and
  returns `{proceed:false,state}`; `step.ts` inlines `publishError(...)` + returns a
  `RetryStepOutcome`. Keep the **return shape** at each call site by having the helper
  return a small structured result (e.g. `{ outcome: 'allow'; changedFiles } |
  { outcome: 'deny'; reason; conflictedFiles? } | { outcome: 'error'; reason }`) and let
  each caller map it to its own return type. Do not push caller-specific return types into
  the helper.
- **conflict handler + bus/phase:** pass `handleConflict(state, files)` and the
  `wctx/ctx` (or the `{bus, phase}` it needs) through options.

Place it in `src/engine/orchestrator/approval/gate-and-promote.ts`. Call the post-B06
signatures of `gateChangedFiles`/`promoteStagedChanges`/`restoreDirtyFilesFromSnapshot`/
`captureCurrentFileContents`/`persist*Evidence`. **This must be behavior-preserving** —
the existing `loop.test.ts`, escalation tests, and `tiered-approval.test.ts` must stay
green without edits.

### Step 3 — DRY-05: `firstBriefErrorMessage`

`runBriefQualityGate`/failure paths in `planning/shared.ts` (post-B10 split — find by
symbol) and `planning/{instant,quick}.ts` + `run/phases.ts` extract the first error
message from a brief-quality report the same way. Add `firstBriefErrorMessage(report)`
next to the report type (`spec/brief-quality.ts`) returning that first error string (match
the current extraction: first issue with `severity === 'error'`, else a default). Replace
the 4 inline extractions.

### Step 4 — DRY-17: user-edit detection tail + named const

In `user-edit/detection.ts`, the success path (lines ~74-83) and the catch-fallback path
(lines ~87-104) both build a recovery issue, `transitionAndSave(... SET_PENDING_RECOVERY)`,
`publishRecoveryPrompted(bus, issue)`, `setTrackedState(state)`, and
`return { state, stopped: true }`. Extract a local `promptRecovery(issue)` (or
`stopWithRecovery`) helper inside the module that takes the built `issue` and performs
those 4 steps + returns `{ state, stopped: true }`. Name the fallback conflict's
`availableActions` as a module const (e.g.
`const CURRENT_TASK_CONFLICT_ACTIONS = ['regenerate-rebase', 'pause', 'skip-current-task',
'abort-workflow'] as const;`) and reference it. Behavior unchanged.

### Step 5 — DRY-18 + DRY-67: `core/state/machine.ts` (collision B02→B08→B12)

Build on B02 (`default: assertNever(action)`) and B08 (`transition(state, action,
opts?)` — keep its signature). Do **not** revert either.

5a. **DRY-18** `rewindReset`. `REWIND_TO_SPEC` (→ `phase: 'specifying'`,
`rewindPending.target: 'spec'`) and `REWIND_TO_PLAN` (→ `phase: 'planning'`,
`rewindPending.target: 'plan'`) are identical except those two values. Add:

```ts
function rewindReset(state: WorkflowState, target: 'spec' | 'plan', comment?: string): WorkflowState {
  return {
    ...state,
    phase: target === 'spec' ? 'specifying' : 'planning',
    tasks: [],
    currentTaskIndex: 0,
    attempt: 0,
    awaitingContinue: false,
    plannerSessionId: undefined,
    clarifications: [],
    constitutionFailureReason: undefined,
    analysisResult: undefined,
    discoveredValidation: undefined,
    rewindPending: { target, ...(comment ? { comment } : {}) },
  };
}
```

The two cases become `return rewindReset(state, 'spec', action.comment)` /
`return rewindReset(state, 'plan', action.comment)`. **Field-for-field identical** to
today.

5b. **DRY-67** `resetToIdle`. The idle-reset cases differ subtly:
`REJECT_SPEC`/`REJECT_PLAN`/`REJECT_BRIEFS` → `{ phase:'idle', tasks:[],
currentTaskIndex:0, attempt:0 }`; `CONSTITUTION_CHECK_FAIL`/`CANCEL` additionally set
`awaitingContinue: false`. Add `resetToIdle(state, opts?: { clearAwaitingContinue?:
boolean })` that returns the idle reset and conditionally adds `awaitingContinue: false`.
Each case calls it with the matching option, preserving its exact current fields. The
audit also notes "call `stripCurrentCode`" — only apply that if the current case already
strips current code; do **not** add new stripping that changes output. Verify against the
existing `machine.test.ts` (must stay green).

### Step 6 — DRY-22 + DRY-35 + DRY-51 + RU-04 (evidence / ledger; collision B06→B09→B12)

Edit at the **post-B09** homes (`core/evidence/ledger.ts`; review-packet may be split by
B10 into `sections-io.ts`/`artifacts.ts`).

6a. **RU-04** generic `uniquePush`. `evidence/task-evidence.ts:16` defines
`uniquePush(arr: string[], value: string)`. Move it to `utils/collections.ts` and make it
generic: `export function uniquePush<T>(arr: T[], value: T): void { if
(!arr.includes(value)) arr.push(value); }`. Update importers: `task-evidence.ts` (re-import
from collections; it has ~12 internal calls), `evidence/reporting.ts:19`, and
`mcp/tool/operations.ts` (~12 calls). `operations.ts` is also touched by B09 (AR-04) —
edit its current state; just swap the import path.

6b. **DRY-35** `getOrCreateLedger`. In `core/evidence/ledger.ts` add:

```ts
export function getOrCreateLedger(input: CreateEvidenceLedgerInput, existing: EvidenceLedger | null): EvidenceLedger {
  return existing ?? createEvidenceLedger(input);
}
```

In `recovery/actions.ts` `recordRecoverySkipEvidence`, replace
`const ledger = existing ?? createEvidenceLedger({...})` with
`getOrCreateLedger({...}, existing)`. (Grep for other `existing ?? createEvidenceLedger`
sites and route them too — keep the exact `CreateEvidenceLedgerInput` each builds.)

6c. **DRY-22** `readReadinessArtifact` + `isBriefQualityReport`. In `review-packet/build.ts`
(or its post-B10 split) `readReadiness(...)` does `readJsonSafe(target)` then guards
`record.type !== 'start-readiness'`. Extract `readReadinessArtifact(projectDir,
sessionId)` returning the validated start-readiness record (or null) and have the packet
builder use it. Add an `isBriefQualityReport(value)` type guard where brief-quality
artifacts are read, replacing the ad-hoc shape checks. Keep the same null/invalid
handling.

6d. **DRY-51** shared selectors + `extractFrontmatter`. `review-packet/sections.ts` counts
task statuses inline (`state.tasks.filter(t => t.status === 'done').length`, etc., lines
~122-125). Extract a small selector (e.g. `countTaskStatuses(tasks)` → `{ passed, failed,
skipped, escalated }`, or reuse `countByValue` from step for DRY-52 over `task.status`)
and call it here and anywhere else the same per-status counts recur (e.g.
`evidence/reporting.ts`/`collect.ts` if they do the same). For the frontmatter half: where
`sections.ts`/`build.ts` parse frontmatter inline, adopt the existing `extractFrontmatter`
from `utils/frontmatter.ts`. Behavior unchanged.

### Step 7 — DRY-27: explain sections

In `explain/sections.ts`:
7a. Adopt `formatKnownCost(amount, isKnown)` (B04, `core/formatting.ts`) for
`actualCostLabel`/`baselineCostLabel`/`savingsLabel`'s `${cost} + unknown` /
`Unknown price` logic — but only where the shape matches `formatKnownCost` exactly
(`isKnown ? formatCost(x) : (x>0 ? formatCost(x)+' + unknown' : 'Unknown price')`). Where
a site's logic differs (e.g. returns `'unavailable'`), keep the surrounding branch and only
fold the `+ unknown` formatting. Do not change any rendered string.
7b. Extract `mergeTaskActivity(...)` for the shared map-build in `taskStatusActivity`
(lines ~200-219) and `skippedActivity` (lines ~222-237): both seed a `Map` from
`state.tasks` filtered by status, then overlay event-derived entries, then return a
sorted array. Parametrize the per-entry shape via a builder callback so both call it.
Output ordering and contents identical. (Note `explain/sections.ts` also takes a B08 param
object at `:69` — do not revert it.)

### Step 8 — DRY-28 + DRY-56: provider usage/pricing

8a. **DRY-28** `parsePartialUsage` + `buildPricingFields`. `anthropic/stream.ts:81-99`
`parseUsage(value): Partial<TokenDelta>` reads `input_tokens`/`output_tokens`/
`cache_read_input_tokens`/`cache_creation_input_tokens`. Rename/move it to a shared
`parsePartialUsage` in `engine/providers/usage.ts` (or the natural post-B10 providers
home) and have `stream.ts` import it. `models-dev.ts:28-38` and `openrouter.ts:43-62`
build `{ pricingInput, pricingOutput }` with the same conditional spread + `?? current`
merge — extract `buildPricingFields(input?: number, output?: number)` returning the
conditional `{ ...(input !== undefined && { pricingInput: input }), ...(output !==
undefined && { pricingOutput: output }) }` and route both. **Byte-identical fields.**
8b. **DRY-56** `Pick<TokenDelta, …>`. `agent-sdk-backend.ts` declares
`{ inputTokens: number; outputTokens: number }` inline twice (lines ~100, ~114) and
`pricing.ts`/`cost.ts` has `type TokenSplit = { inputTokens: number; outputTokens: number }`.
Replace the inline shapes with `Pick<TokenDelta, 'inputTokens' | 'outputTokens'>` (import
`TokenDelta`), or export the single `TokenSplit` from the providers module and reuse it in
`agent-sdk-backend.ts`. (The file is `cost.ts` post-B10/D9.)

### Step 9 — DRY-29: hoist Claude pricing consts

In `core/providers/known-models.ts` (lines ~110-155) the `CLAUDE_*_PRICING` numbers are
repeated inline per model. Hoist them to named module-scope consts (e.g.
`const CLAUDE_OPUS_PRICING = { input: …, output: … } as const;`) and reference them.
**Same numeric values.**

### Step 10 — DRY-30: adopt `extractJsonBlock` (behavior-sensitive — read carefully)

`extractJsonBlock` (B04, `utils/extract-json-block.ts`) uses fence regex
`/```(?:json)?\s*\n([\s\S]*?)\n```/` (requires newlines), falls back to a **balanced**
first object, and returns `unknown` (`{}` on failure). The two remaining adopters parse
**differently**:
- `planner-estimate-review.ts` (post-B10: `estimate-review-parser.ts`) `jsonCandidate`
  uses `/```(?:json)?\s*([\s\S]*?)```/i` and a greedy `indexOf('{')`…`lastIndexOf('}')`
  fallback, returning a **string candidate** then `JSON.parse`.
- `parsers/question-parser.ts` uses a `substring(jsonStart, afterJson)` slice.

**Adoption is mandatory at all 3 remaining sites; behavior-preservation is the
constraint, not an escape hatch.** Do **not** blindly swap (that would change parsing) and
do **not** silently skip (a zero-change site reads as a coverage GAP to the validator —
D11 moots only `branch-summary`, not these). For each site (`estimate-review-parser`/
`planner-estimate-review.ts` and `parsers/question-parser.ts`):
1. Replace the local extractor with `extractJsonBlock(text)`, keep the existing
   `narrowRecord(...)`/`JSON.parse`-result narrowing, and **remove** the now-dead local
   `jsonCandidate`/`substring` helpers.
2. Make it behavior-equivalent by **normalizing the input or post-processing** so
   `extractJsonBlock` returns the same parsed value the old extractor did for that site's
   real inputs — verified by the colocated tests (`estimate-review`/`question-parser`
   specs), which must stay green unchanged. (The differences are the fence regex requiring
   `\n` and the balanced-object vs greedy `lastIndexOf` fallback; reconcile by pre-trimming
   or by widening `extractJsonBlock`'s call appropriately at the call site, not by editing
   the shared helper — that is B04's.)
3. If, after a genuine attempt, a site is **truly irreconcilable** without changing
   observable parse results, that is a **human escalation** per the implement→validate
   loop (flag it explicitly in your handback), **not** a silent N/A. Do not regress
   behavior to force the dedupe, and do not quietly leave it unaddressed.

`speckit.ts` is already migrated by B04 — do not touch it.

### Step 11 — DRY-31 + DRY-77: handoff renderers

11a. **DRY-31** In `handoff/renderers/shared.ts` `formatTaskBrief`, reuse `buildScopeLines`
(exported from `spec/formatter.ts`) for the in/out-of-bounds rendering and `listOrNone`
for escalation/evidence — **but only if** the resulting strings are identical. Note the
current `formatTaskBrief` uses `'none declared'` fallbacks and a specific in/out layout
(`**In bounds:**\n…\n**Out of bounds:**\n…`) that differs from `buildScopeLines`' shape.
If the formats differ, prefer reusing `listOrNone` (clearly shared) for escalation/evidence
and leave the scope rendering if folding it would change output. Do not change the emitted
handoff text. (If only a partial reuse is safe, do the safe part and note the rest.)
11b. **DRY-77** Add `buildTaskListSection(tasks: Task[]): string` to
`handoff/renderers/shared.ts` returning ```` `## Tasks\n\n${tasks.map(taskLink).join('\n')}\n` ````
and have `agents-md.ts` and `claude-code.ts` interpolate it in place of their inline
`## Tasks\n\n${taskLines}\n` blocks. **Byte-identical** output. The "load config once" half
of the row is the handoff-write path (PF-01, owned by B16) — out of scope here.

### Step 12 — DRY-36: `bindPlannerToProjectDir`

Both `transcript-rebuild.ts:72-77` (`performManualCompaction`) and `resume-context.ts:43-46`
(`autoCompactResumeContext`) build the same adapter:
`{ summarize: messages => summarize(messages, projectDir), ...(summarizeStructured ?
{ summarizeStructured: (messages, previous) => summarizeStructured(messages, previous,
projectDir) } : {}) }`. Add `bindPlannerToProjectDir(planner, projectDir)` in
`transcript-rebuild.ts` returning that adapter (typed to the `{summarize,
summarizeStructured?}` shape `compactTranscript`/`compactResumeTranscript` accept) and use
it at both sites. Keep the exact `summarize`/`summarizeStructured` semantics.

### Step 13 — DRY-37: `configForProfile`

`task/routing.ts:9` (`taskConfigForProfile`) and `escalation/retry-runtime.ts:17`
(`retryConfigForProfile`) are byte-identical (`{ ...config, implementer: profile.config }`);
`task/loop.ts:141` calls `taskConfigForProfile`. Define one `configForProfile(config,
profile)` **in `task/routing.ts`** (both sites are under `engine/orchestrator/`, and
`routing.ts` already holds the profile helpers). Delete `taskConfigForProfile` (replace
with `configForProfile`) and delete `retryConfigForProfile` from `retry-runtime.ts`,
importing `configForProfile` there instead. Update all callers (`loop.ts:141`, and the
retry path that used `retryConfigForProfile`). Leave `stateForRetryProfile` alone (already
single-sourced).

### Step 14 — DRY-40: `isRecord` in `project-meta.ts`

In `core/project-meta.ts`, import `isRecord` from `utils/type-guards.js`. Replace the
inline `parsed && typeof parsed === 'object' && !Array.isArray(parsed)` (returning
`parsed as Record<…>`) with `isRecord(parsed) ? parsed : null` (removes the `as` cast),
and the two `deps` checks (lines ~29-30) with `isRecord(pkg['dependencies'])` /
`isRecord(pkg['devDependencies'])`. Behavior unchanged.

### Step 15 — DRY-44: `renderSectionLines`

In `core/readiness/format.ts`, `formatReadinessReport` and `formatReadinessBlockers` both
render a section the same way (`${section.title}:`, then per-check
`  ${SEVERITY_LABELS[check.severity]} ${check.id}: ${check.summary}`, details, `Fix:`).
Extract `renderSectionLines(section): string[]` and call it in both loops. Note the small
difference: `formatReadinessReport` `continue`s on empty-checks sections; preserve that at
the call site (skip empty before calling, or have the helper return `[]`). **Byte-identical**
output.

### Step 16 — DRY-52: `countByValue`

Add to `utils/collections.ts`:

```ts
export function countByValue<T, K extends string>(items: readonly T[], key: (item: T) => K): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
```

> Type the accumulator `Partial<Record<K, number>>` so the empty `{}` needs **no** `as`
> cast (the D1 invariants gate rejects new broad `as`). Read with `counts[k] ?? 0`.

In `budget/estimate.ts`, replace `fitCounts`/`contextConfidenceCounts`/
`priceConfidenceCounts` (each `tasks.filter(t => t.X === 'value').length` per value) with
`countByValue(tasks, t => t.contextFit)` etc., then **shape the result to the exact
return type** (the functions return fixed-key objects like
`{ fits, tight, overflow, unknown }` — build that object from the counts with `?? 0`
defaults so missing keys stay `0`). The returned objects must be identical to today.

### Step 17 — DRY-53: `failedRetry`

Add `failedRetry` with an **explicit return type** matching the existing result shape (find
the `RetryResult`/outcome type in `escalation/types.ts` and annotate the function with it),
e.g. `export function failedRetry(attempts: number): RetryResult { return { completed:
false, method: 'failed', attempts }; }` — the explicit return type pins `method` to its
literal without a widening `as`. Put it in `escalation/types.ts` or a small shared module
reachable by `step.ts`/`escalation.ts`/`run-escalation-tier.ts`. Replace the
`{ completed: false, method: 'failed', attempts: X }` literals in `escalation/escalation.ts`
(6 sites — `attempts: 0`, `retries.attempts`, `tier0.attempts`, etc.), `escalation/step.ts`
(5 sites — `attempts`), and `escalation/run-escalation-tier.ts` (1 site). Pass each site's
existing attempts expression. Do **not** touch the `{ state, completed, validationResults,
blockedReason }` shapes in `validate-and-commit.ts` (different type; B14 owns that file).

### Step 18 — DRY-54: `toRejectedProfile`

In `context-routing/route.ts`, both `rejected` `.map(profileFit => ({ profile, costTier,
profileWriteMode, requiredWriteMode, reason, fit, estimatedTokens,
untruncatedEstimatedTokens, contextLength, currentCodeTruncated, currentCodeContextMode
}))` blocks are identical except `reason: rejectionReason(profileFit)` vs
`rejectionReason(profileFit, selected)`. Extract `toRejectedProfile(profileFit, selected?)`
that builds the object using `rejectionReason(profileFit, selected)` (when `selected` is
omitted it calls the single-arg form). Both `.map(...)` calls become
`.map(pf => toRejectedProfile(pf))` / `.map(pf => toRejectedProfile(pf, selected))`.
Identical objects.

### Step 19 — DRY-55: `STREAM_IDLE_TIMEOUT_MESSAGE`

In `engine/constants.ts`, next to `STREAM_IDLE_TIMEOUT_MS`, add the idle-timeout message
string that `output-parsers.ts:159` and `anthropic/stream.ts:266` currently inline (copy
the exact current text). Reference the const at both sites (post-B10 `output-parsers.ts`
may be split — find the format that owns it). **Same string.**

### Step 20 — DRY-58: `createLineBuffer` in `streaming-feed.ts` (behavior-sensitive)

`createLineBuffer(onLine)` (`lib/process/line-buffer.ts`) emits **only complete lines**
on `\n`. `streaming-feed.ts` additionally pushes the **in-progress remainder** to the ring
buffer when `remainder.trim().length > 20`. Drive the line-splitting via `createLineBuffer`
(use its `push`, and call `onLine` to push non-empty trimmed complete lines to the ring
buffer), but **preserve the `>20`-char partial-line flush**: after `lineBuffer.push(text)`,
peek the buffer's remainder and push it trimmed to the ring buffer when its trimmed length
> 20, exactly as today. `createLineBuffer` does not expose its remainder, so either (a)
keep a parallel remainder for the peek, or (b) leave the remainder logic local and only use
`createLineBuffer` for the complete-line split — whichever keeps `ringBuffer` contents
**identical** for the same input stream. If a colocated test exists, it must stay green.

### Step 21 — DRY-59a: `DIPTYCH_DIR` (engine sites)

Grep `src/engine` for the `'.diptych'` literal (`grep -rn "'\.diptych'" src/engine`) and
replace each with `DIPTYCH_DIR` imported from `core/paths.js`. Where `core/paths.ts`
already exposes a composed path helper (e.g. `sessionDir`, etc.) for that location, prefer
the helper. There is **no** `getDiptychPath` function today — use the `DIPTYCH_DIR`
constant (do not invent a function name). The DRY-59b twin (cli/core sites, **B13**) names
`getDiptychPath`/`DIPTYCH_DIR` the same way; B12 and B13 must agree — use only the existing
`DIPTYCH_DIR` const, do not create `getDiptychPath`. Same resolved paths.

### Step 22 — DRY-61: `emptyActiveChain`

In `drift/chain.ts:69`, replace the inline empty-active-chain literal with a call to
`emptyActiveChain()` imported from `drift/chain-state.js`. Identical value.

### Step 23 — DRY-66: adopt `formatTruncatedList` (UI files)

`formatTruncatedList(values, max)` (B04, `core/formatting.ts`) returns
`hidden > 0 ? `${visible}, +${hidden} more` : visible` for `visible =
values.slice(0,max).join(', ')`. Replace the inline copies in
`features/workflow/task-review-prompt.ts`, `features/workflow/user-edit-conflict-prompt.ts`,
`features/workflow/recovery-prompt.ts`, and `features/workflow/conversation-rows/event-format.ts`
(the `values.slice(0,max)…+N more` blocks) with `formatTruncatedList(values, max)`. Confirm
each site's separator is `', '` and suffix is `, +N more`; if a site differs, leave it.
**Same output.** (These are UI files but are B12's per the traceability.)

### Step 24 — DRY-67 — covered in Step 5b.

### Step 25 — RU-16: `RecoveryFact` accessors → `core/schemas/recovery.ts`

`recovery-prompt.ts:174-184` defines `factString`/`factNumber` over
`Record<string, RecoveryFact> | undefined`; `recovery/actions.ts:413-423` defines
`issueFactString`/`issueFactNumber`/`issueFactBoolean` over a `RecoveryIssue` (reading
`issue.facts?.[key]`). Add the canonical accessors next to `RecoveryFact` in
`core/schemas/recovery.ts`:

```ts
export function recoveryFactString(facts: Record<string, RecoveryFact> | undefined, key: string): string | undefined { … }
export function recoveryFactNumber(facts: Record<string, RecoveryFact> | undefined, key: string): number | undefined { … }
export function recoveryFactBoolean(facts: Record<string, RecoveryFact> | undefined, key: string): boolean | undefined { … }
```

(bodies copied verbatim from the existing accessors — string-trim-nonempty, number, boolean).
In `recovery-prompt.ts` import `recoveryFactString`/`recoveryFactNumber`. In
`recovery/actions.ts` replace `issueFact*` with `recoveryFact*(issue.facts, key)` (the
issue-level wrappers were just `issue.facts?.[key]` reads). Identical results.

### Step 26 — D12 adoptions with no standalone ID (engine)

- `worktree.ts`: replace `phase === 'complete' || phase === 'idle'` (two sites) with
  `isTerminalPhase(phase)` (`core/phases.js`).
- `drift/drift.ts`: replace the local `isCompleted` body (`status === 'done' || status ===
  'escalated'`) with `isTaskCompleted(status)` (`core/schemas/task.js`) — and adopt
  `isTaskCompleted` at `recovery/actions.ts:367` and `task/loop.ts:153`. Leave
  `=== 'done'`-only checks (`loop.ts:185`) untouched.
- `escapeRegExp` (DRY-39 adoption): replace the inline
  `value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` in `planners/cli.ts`,
  `codebase/repomap.ts`, `parsers/scope-extractor.ts` with `escapeRegExp(...)` imported
  from `utils/regexp.js`. Identical regex behavior.

### Step 27a — DRY-08a: adopt `pluralize` (engine)

`pluralize(n, singular, plural?)` (`utils/format.js`) returns `n === 1 ? singular : plural
?? `${singular}s``. Run **all** of these patterns over `src/engine` (excluding `*.test.ts`)
and adopt at each hit:

```bash
grep -rnE "=== 1 \? '' : 's'|!== 1 \? 's'|=== 1 \? \"\" : \"s\"|\? '' : 's'|\? \"\" : \"s\"|=== 1 \? [\"'][a-z]+[\"'] :|!== 1 \?|length === 1 \?|count === 1 \?|=== 1 \? singular" src/engine | grep -v '\.test\.'
```

The drafter ran this broadened set against the current tree and found **zero** engine
sites (the inline pluralization copies are all UI/CLI, owned by B13). Re-run it against the
post-wave tree: if it is still empty, record DRY-08a as PASS-by-absence **and quote the
empty grep result** as evidence; if any site appears (a later wave may have added one),
replace it with `pluralize(...)`. Do not change any pluralized output.

### Step 27b — formatPercent adoption (engine, no standalone ID)

`formatPercent(value)` (`core/formatting.ts`, B04) returns `!Number.isFinite(value) ?
'unknown' : `${Math.round(value)}%``. The B04 origin (`recovery/builders/{shared,workflow}.ts`)
already uses it. Find remaining engine inline `${Math.round(x)}%` sites:

```bash
grep -rnE "Math\.round\([^)]*\)\}%" src/engine | grep -v '\.test\.'
```

Adopt `formatPercent(x)` **only where the value is always finite** (so the `'unknown'`
guard cannot change output) and where the result is exactly `${Math.round(x)}%` — e.g.
`budget/budget.ts:125` (`${Math.round(effectivePauseThreshold * 100)}%`). **Do NOT touch
`engine/export/html-renderer.ts`** — that file is owned by **B11** (DRY-62/FO-05). If a
candidate could see a non-finite value, leave it (adopting would change output to
`'unknown'`). Record any site left untouched and why.

## Out of scope (owned elsewhere — do NOT touch)

- `engine/orchestrator/escalation/validate-and-commit.ts` — its 3rd `gateAndPromote` copy
  is dead and **deleted by B14 (DC-02)**. Do not refactor it.
- The **producer** definitions of every adopted helper (`pluralize`, `formatPercent`,
  `formatKnownCost`, `formatTruncatedList`, `formatTaskId`, `isTerminalPhase`,
  `isTaskCompleted`, `extractJsonBlock`, `escapeRegExp`, `clamp`, `renderMeterBar`, etc.) →
  **B04**. You adopt; you do not redefine or move them.
- `pricing.ts`→`cost.ts` rename/split and the `calculateUsageCost` signatures → **B10/B07**.
  You only touch the `TokenSplit`/`Pick<TokenDelta>` shape (DRY-56) and `parsePartialUsage`/
  `buildPricingFields` (DRY-28) at their post-rename homes.
- `output-parsers.ts` / `planning/shared.ts` / `review-packet/{sections,build}.ts` /
  `planner-estimate-review.ts` **file splitting** → **B10**. You edit the post-split files.
- **Snapshot dedup residue** (`createSnapshot`/`captureFile`/`buildManifest`,
  `snapshots/store.ts`) — listed in the coordinator's B12 prose but it has **no DRY/RU
  finding ID assigned to B12**; it is covered by **B10 (DRY-45/SRP-01)**. Do **not** touch
  `snapshots/store.ts` — if a validator raises it, it is B10's, not a B12 gap.
- `core/state/machine.ts` `assertNever` default (**B02**) and `transition` trailing opts
  (**B08**) — keep, do not revert.
- `core/evidence/ledger.ts` extraction + `recomputeValidationSummary` dedup (**B09**);
  `evidence/persistence.ts` param objects (**B06**). You add selectors/`getOrCreateLedger`
  only.
- CLI/UI adoption of `pluralize`/`formatCost`/`wrapHard`/`renderMeterBar`/`capitalize`/
  `formatTaskId`/`resolveEditorCommand`/`cloneDetectedModel`/`renderTable`/`.diptych`
  (cli/core sites)/scroll-window/`clampIndex` → **B13** (DRY-08b,12,14-16,23,24,47-50,57,
  59b,64,65,68-75,78; RU-11,17). Do not adopt those.
- Handoff config "load once" (PF-01), `mergeCatalogEntries` KISS, `normalizeCapabilities`,
  etc. → **B16**.
- Deleting `pluralize`/`clamp`/`isTerminalPhase`/`isTaskCompleted` or any adopted symbol →
  forbidden (D12); B14 honors ADOPT-NOT-DELETE.
- Any `*.test.ts` rewrite → **B15**. You may run tests; only edit a test if an extraction
  forces a colocated test to update its import path (prefer keeping the public surface
  stable so tests pass unchanged).

## Acceptance criteria

- [ ] Every finding ID in the table above is addressed in the code (DRY-03,05,08a,11,17,18,
  22,25,26,27,28,29,30,31,32,35,36,37,40,44,51,52,53,54,55,56,58,59a,61,66,67,77; RU-04,16),
  plus the no-standalone-ID engine adoptions (`isTerminalPhase`, `isTaskCompleted`,
  `escapeRegExp` adoption sites).
- [ ] `TASK_BRIEF_HEADINGS` and `REQUIRED_BRIEF_SECTIONS` exist in `engine/spec/headings.ts`
  and are consumed by `formatter.ts`, `prompt-formatter.ts`, `parser.ts`, and the planner
  prompts — with **parser aliases preserved** (D10). `formatter.test.ts`/`parser.test.ts`
  pass unchanged.
- [ ] `gateAndPromoteChangedFiles` is the single implementation of the gate→capture→
  promote flow; `escalation/step.ts` and `task/apply-changed-files.ts` call it; behavior is
  unchanged (`loop.test.ts`, escalation tests, `tiered-approval.test.ts` green without
  edits). `validate-and-commit.ts` is untouched.
- [ ] New shared helpers exist and are exported once each: `firstBriefErrorMessage`,
  `getOrCreateLedger`, generic `uniquePush<T>` (in `utils/collections.ts`), `countByValue`,
  `failedRetry`, `toRejectedProfile`, `bindPlannerToProjectDir`, `configForProfile`,
  `buildTaskListSection`, `renderSectionLines`, `readReadinessArtifact`/`isBriefQualityReport`,
  `mergeTaskActivity`, `parsePartialUsage`/`buildPricingFields`, `fenced`,
  `STREAM_IDLE_TIMEOUT_MESSAGE`, the `RecoveryFact` accessors; `machine.ts` has
  `rewindReset`/`resetToIdle`.
- [ ] Adopted-from-existing helpers route correctly: `isRecord` (project-meta),
  `countBySeverity`/`buildEvidenceSummary` (collect/reporting/brief-quality),
  `extractFrontmatter` (evidence), `createLineBuffer` (streaming-feed, with the `>20`
  partial flush preserved), `emptyActiveChain` (drift/chain), `DIPTYCH_DIR` (engine
  `.diptych` sites), `extractJsonBlock` (the behavior-equivalent DRY-30 sites only).
- [ ] DRY-30 sites that are **not** provably behavior-equivalent to `extractJsonBlock` are
  left unchanged (no parsing regression); `speckit.ts` untouched (done by B04).
- [ ] All extractions/adoptions are **behavior-preserving** (byte-identical output for the
  same inputs) except none are authorized to change behavior — verify the explain cost
  labels, handoff text, machine reducer output, and prompt strings are identical.
- [ ] No symbol promoted by B04 is deleted or marked dead (D12).
- [ ] No new `!`/broad `as`/`any`/barrels/non-Error classes/memoization; `.js` imports
  everywhere; `engine/` imports nothing from `react`/`ink`/`features`/`components`/`hooks`
  (the UI files you edit — `recovery-prompt.ts`, the DRY-66 prompts — are themselves UI and
  may import `core/`; engine files must not gain UI imports); no decorative comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass; any test edited only for an import path that an extraction forced.

## Tests

```bash
npm test -- \
  src/engine/spec \
  src/engine/orchestrator/escalation \
  src/engine/orchestrator/planning \
  src/engine/orchestrator/run \
  src/engine/orchestrator/user-edit \
  src/core/state/machine \
  src/engine/orchestrator/evidence \
  src/engine/orchestrator/explain \
  src/engine/orchestrator/recovery \
  src/engine/orchestrator/context-routing \
  src/engine/orchestrator/budget \
  src/engine/orchestrator/drift \
  src/engine/orchestrator/task \
  src/engine/providers \
  src/core/providers \
  src/engine/handoff \
  src/engine/streaming \
  src/core/readiness \
  src/core/project-meta \
  src/core/schemas/recovery \
  src/utils/collections \
  src/features/workflow
npm run typecheck
npm run lint
```

If a colocated test does not exist for a touched module, run the nearest enclosing suite.
Because B12 lands in wave 7, also expect the wave gate `npm run test-ci` (typecheck → lint
→ test → check:invariants) to run after this brief — keep all four green.
