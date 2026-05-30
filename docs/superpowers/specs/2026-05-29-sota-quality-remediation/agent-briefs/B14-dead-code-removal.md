# B14 — Dead-code removal (+ knip dead-export CI gate)

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Remove genuinely dead code across the codebase: two fully-unreachable session-tree
subsystems (~500 LOC incl. tests), one unreachable approval branch, a set of dead
exports/fields/params, computed-then-overwritten fields, and ~14 dead `z.infer` aliases
plus ~30 over-exported internals. Then add a **knip** dead-export/dead-file CI gate
(wired into `check:invariants`) so the regression can never silently return. Every
deletion must leave `typecheck`, `lint`, and the affected tests green. Honor D11 (the
session-tree deletion moots a DRY finding) and D12 (never delete the adopt-not-delete
helpers).

## Wave / ordering

- **Wave:** 8. **Runs after:** B12 and B13 (all adoption briefs) because D12 helpers
  (`pluralize`, `clamp`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`, …) only
  stop being "dead" once B12/B13 adopt them; deleting them earlier would be wrong. B14
  also runs **before** B15 (test fixes) so test edits can account for the removals.
- **Decisions that bind this brief:**
  - **D11** — Deleting `branch-summary.ts`/`reconstruct.ts` (and siblings) **moots**
    DRY-30's `branch-summary` JSON-extractor sub-item. Do not re-add an extractor there.
  - **D12** — `pluralize` and the other promoted helpers are **ADOPTED, not deleted**.
    B14 must **not** delete `pluralize`, `clamp`/`clamp01`, `formatPercent`,
    `isTerminalPhase`, `isTaskCompleted`, `formatKnownCost`, `formatTokensShort`,
    `capitalize`, `wrapHard`, `renderMeterBar`, `formatTaskId`, `escapeRegExp`,
    `cloneDetectedModel`, `resolveEditorCommand`, `isPathConfined`, or any symbol B04
    promoted for adoption. If knip flags one of these as unused, that means B12/B13 did
    not finish adopting it — **report it as a gap, do not delete it.**

## File ownership

You **edit/delete** the following. For collision files, only the listed concern is yours.

**Delete entirely (DC-01):**
- `src/core/sessions/tree/branch-summary.ts` + `src/core/sessions/tree/branch-summary.test.ts`
- `src/core/sessions/tree/summary-prompt.ts` + `src/core/sessions/tree/summary-prompt.test.ts`
- `src/core/sessions/tree/branch-context.ts` (no test)
- `src/core/sessions/tree/reconstruct.ts` + `src/core/sessions/tree/reconstruct.test.ts`

**Delete entirely (DC-04, DC-05 see note):**
- `src/features/workflow/components/cost/footer.tsx` — **ONLY IF** DC-05 is confirmed dead
  (it is NOT — see Findings note; do **not** delete this file).

**Edit:**
- `src/engine/orchestrator/escalation/validate-and-commit.ts` (DC-02) — not in the
  collision map; fully yours.
- `src/engine/providers/registry.ts` (DC-03)
- `src/components/markdown.tsx` (DC-04)
- `src/engine/orchestrator/recovery/builders/shared.ts` (DC-06) — **collision** (B04 →
  B10 → B14). B04 moved `formatPercent`/`formatCostFact` to core; B10 split the
  remainder. **You own only** deleting `hasRetryBudget` + `summarizeUnknownError`. Build
  on whatever the file looks like after B04/B10.
- `src/engine/skill-discovery.ts` (DC-07)
- `src/core/state/types.ts` + `src/core/state/machine.ts` (DC-08) — **collision** on
  `machine.ts` (B02 → B08 → B12). **You own only** dropping the
  `RESOLVE_PENDING_RECOVERY.action` payload; B02/B08/B12 own their concerns.
- `src/engine/orchestrator/recovery/actions.ts` (DC-08 call-site fallout — remove the
  `action:` it passes to the action; this file is **not** in the collision map).
- `src/core/schemas/snapshot.ts` (DC-09)
- `src/engine/implementers/types.ts` + `src/engine/orchestrator/task/run-implementation.ts`
  (DC-10)
- `src/engine/planners/planning-helpers.ts` + `src/engine/planners/base.ts` (DC-11)
- `src/stores/workflow/tokens.ts` (DC-12) — **collision-adjacent**: B13 owns DRY-24
  (export `PhaseTokens`/`PerTaskTokens` + derive from `drilldown-overlay.tsx`). B13 lands
  first (wave 7). **You own only** removing the vestigial `cost` fields. Build on B13's
  version of the file; do not touch the export/derive work.
- `src/core/sessions/tree/store.ts` + `src/core/sessions/tree/store.test.ts` (DC-13 +
  cascade)
- `src/engine/detection/detect.ts` (DC-14 / AS-03)
- `src/core/sessions/tree/entry-types.ts` (DC-15)
- `src/engine/orchestrator/events.ts` (DC-16) — **not** in collision map for B14; B06 owns
  PD-28 param objects on publishers but lands in wave 4. Build on B06's version; you own
  only dropping the `export` keyword on `publishRecoveryEvent`.
- `src/engine/orchestrator/auto-split-overflow.ts` (DC-17) and
  `src/engine/claude-invoke.ts` (DC-17). `src/core/migration/executor.ts` and
  `src/engine/orchestrator/planner-estimate-review.ts` — inspect for DC-17; likely no-op
  (see step 17).
- `src/core/schemas/summary.ts` (+ the 6 sibling schema files knip flags) (DC-18)
- `src/features/workflow/handlers.ts` (+ ~30 sites knip flags) (DC-19)
- `src/utils/type-guards.ts` (`isNonNull`), `src/features/home/logo.ts`
  (`FULL_LOGO_WIDTH`), `src/engine/streaming/token-utils.ts` (`TokenUsageLike`),
  `src/core/layout/event-sections.ts` (`DynamicSection`),
  `src/stores/ui/command-palette-mru.ts` (`getRank`) (DC-20). **`src/utils/format.ts`
  `pluralize` is ADOPT — do NOT delete (D12).**

**Create / edit for the gate:**
- `package.json` — add `knip` devDep + `knip` script.
- `knip.json` (new, repo root) — knip config.
- `scripts/check-invariants.ts` (DC-18 gate) — **collision** (B02 → B14). B02 added the
  unsafe-assertion gate. **You own only** appending one new `Gate` for knip. Do not touch
  B02's gates.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| DC-01 | high | `core/sessions/tree/{branch-summary,summary-prompt,branch-context,reconstruct}.ts` (+tests) | Delete all four modules + their tests (~500 LOC). Moots DRY-30 branch-summary sub-item (D11). |
| DC-02 | high | `engine/orchestrator/escalation/validate-and-commit.ts:25,40-89` | Make `preApprovedChangedFiles` a **required** `string[]`; delete the `if (preApprovedChangedFiles === undefined)` gate/restore branch + now-unused imports. |
| DC-03 | med | `engine/providers/registry.ts:93-97` | Delete exported `createClient` (+ its now-unused `validateProviderBaseURL`/`getProviderById` imports if orphaned). |
| DC-04 | med | `components/markdown.tsx:170` | Delete exported `MarkdownBlock` + its private-only render island. |
| DC-05 | med | `cost/footer.tsx` + `utils/format-time.ts` | **NOT DEAD in current code — mark PASS, change nothing.** `computeEta` is used by `input-footer.tsx:77`; `formatEta` is used by `computeEta`. See note. |
| DC-06 | med | `recovery/builders/shared.ts` (`hasRetryBudget`, `summarizeUnknownError`) | Delete both exported functions (no consumers). |
| DC-07 | med | `engine/skill-discovery.ts:~129-148` | Delete the unreachable `case 'codex'`/`case 'aider'` arms in `getGlobalDir`/`getProjectDir`; narrow their return type to `string` (drop `| null`); simplify callers. |
| DC-08 | med | `core/state/types.ts:54` + `machine.ts:372` (+`recovery/actions.ts`) | Drop the unread `action` from the `RESOLVE_PENDING_RECOVERY` action type; remove `action: opts.action` at the 4 dispatch sites. |
| DC-09 | med | `core/schemas/snapshot.ts:44` | Remove `taskId` from `RunSnapshotLedgerSchema` (never written or read; `taskIndex` is the real one). |
| DC-10 | med | `engine/implementers/types.ts:42` + `run-implementation.ts:65,77` | Remove `bus?` from `ImplementerOptions`; drop the two `bus: wctx.bus` props passed into `.implement({...})`. |
| DC-11 | med | `engine/planners/planning-helpers.ts:55` + `base.ts:166,182` | Remove the unused `_phaseName` param from `runSinglePhasePlanning`; drop the dead literal arg at both call sites. |
| DC-12 | med | `stores/workflow/tokens.ts:22,27,98,156,170,179` | Remove `cost` from `PhaseTokens` and `PerTaskTokens`; drop every `cost: 0`/`cost: existingPhase.cost`/`cost` in defaults. |
| DC-13 | med | `core/sessions/tree/store.ts:137,142` | Delete `childrenOf` + `isOnActivePath`; then delete the now-orphaned `activePath` (store.ts:133) and `pathToRoot` (store.ts:121) — see cascade in step 13; update `store.test.ts`. |
| DC-14 = AS-03 | med | `engine/detection/detect.ts:125-127,138` | Inline `detectAvailableImplementers` at its single call site (`detectAll`); delete the function (its `?? detectAvailableProviders()` fallback is dead — `providerResults` is always supplied). |
| DC-15 | m/l | `core/sessions/tree/entry-types.ts:5-10,67-88` | Delete the dead pair `ENTRY_TYPES`/`EntryType` and `SessionStartPayload(Schema)` (0 consumers); after DC-01, `BranchSummaryPayload(Schema)` is also orphaned — delete it too. Keep schemas with real consumers. |
| DC-16 | med | `engine/orchestrator/events.ts:202` | Drop `export` on `publishRecoveryEvent` (used only by 3 in-file wrappers). |
| DC-17 | l–m | `auto-split-overflow.ts:166`, `claude-invoke.ts:117`, (`executor.ts`, `planner-estimate-review.ts:86` inspect) | Drop computed-then-overwritten fields / dead branches — see step 17. |
| DC-18 | low | `core/schemas/summary.ts` (+6 schema files) | Drop the `export` on the ~14 dead `z.infer` aliases knip identifies; **add the knip gate** to `check:invariants`. |
| DC-19 | low | `features/workflow/handlers.ts:20` (+~30 sites) | Drop `export` on ~30 over-exported module-private symbols knip flags (not test seams). |
| DC-20 | low | `type-guards.ts:15`, `logo.ts:14`, `token-utils.ts:17`, `event-sections.ts:24`, `command-palette-mru.ts:19` | Delete `isNonNull`, `FULL_LOGO_WIDTH`, `TokenUsageLike`, `DynamicSection`, `getRank`. **`pluralize` (format.ts) is ADOPT — do NOT delete (D12).** |

## Required changes

Work top-to-bottom. After each deletion run `npm run typecheck` to catch the next
orphan in the cascade. **The knip gate (step 18) is the safety net that surfaces
everything you missed — run it before declaring done and clean whatever it lists
(except D12 helpers).**

### 1. DC-01 — delete the two dead session-tree subsystems

Delete these 6 files:
- `src/core/sessions/tree/branch-summary.ts`, `branch-summary.test.ts`
- `src/core/sessions/tree/summary-prompt.ts`, `summary-prompt.test.ts`
- `src/core/sessions/tree/branch-context.ts`
- `src/core/sessions/tree/reconstruct.ts`, `reconstruct.test.ts`

Verified zero external consumers. **Do not** confuse `reconstruct.ts` (dead; exports
`reconstructState`/`entriesOfType`/`displayableEntries`/`ReconstructedState`) with the
LIVE `reconstructTree` in `io.ts:92` (keep it; `io.test.ts` stays untouched). `branchFrom`,
`appendEntry`, `createEmptyTree` in `store.ts` stay (used by `tree-recorder.ts`).

### 2. DC-02 — required param + delete unreachable branch in `validate-and-commit.ts`

Current signature (lines 17-26) ends with `preApprovedChangedFiles?: string[]`. The only
production caller (`escalation/step.ts:132`) and the test caller (`step.test.ts:131-155`)
**always** pass it. Therefore:
- Change `preApprovedChangedFiles?: string[]` → `preApprovedChangedFiles: string[]`
  (required, no `?`).
- Change line 29 from `changedFiles = preApprovedChangedFiles ?? await getChangedFilesSinceSnapshot(...)`
  to `changedFiles = preApprovedChangedFiles;` and delete the surrounding `try/catch`
  only if it becomes pointless — **keep** the `try/catch` is no longer needed because the
  await is gone; you may simplify `let changedFiles: string[];` to
  `const changedFiles = preApprovedChangedFiles;`. Remove the now-dead first `catch`
  block (lines 28-39).
- Delete the entire `if (preApprovedChangedFiles === undefined) { … }` block (lines
  40-89). `step.ts` already gates+restores upstream.
- Remove imports that become unused after the block is gone:
  `captureCurrentFileContents`, `getChangedFilesSinceSnapshot`,
  `restoreDirtyFilesFromSnapshot` (from `../approval/file-snapshots.js`),
  `gateChangedFiles` (`../approval/gate-files.js`),
  `handleApprovalTimeUserEditConflict` (`./approval-conflict.js`),
  `persistRetryApprovalEvidence`, `persistRetryRejectionEvidence` (`./retry-evidence.js`).
  Verify each with the editor / typecheck before removing — keep any still referenced by
  the surviving code (e.g. `validateCommitAndAdvance`, `publishError`, `toErrorMessage`
  stay).
- Leave the `signal?.aborted` check (line 90+) and the `validateCommitAndAdvance` call
  untouched.

### 3. DC-03 — delete `createClient` in `engine/providers/registry.ts`

Delete the exported `createClient(config: Config): OpenAI` (lines 93-97). After removal,
the `OpenAI` type import (line 1) and `createClientFromProvider` (imported at line 6) are
orphaned **in this file** — drop both from this file's imports. **Keep**
`validateProviderBaseURL` (still used at line 52). Note `createClientFromProvider` itself
lives in `client.js` and is still used by `implementers/api.ts`/`planners/api.ts` — you
are only removing this file's now-unused *import* of it, not the function.

### 4. DC-04 — delete `MarkdownBlock` in `components/markdown.tsx`

Delete the exported `MarkdownBlock` (line 170) and its private-only render island (the
helpers used solely by it). Zero consumers (not even tests). Keep the rest of the file's
exports.

### 5. DC-05 — NO CHANGE (mark PASS)

The audit listed `computeEta`/`formatEta` as dead. **They are not** in current code:
`computeEta` (`cost/footer.tsx`) is imported and used by `input-footer.tsx:4,77`, and
`InputFooter` is rendered by `workflow-chrome.tsx:89`; `formatEta` is used by
`computeEta`. Do **not** delete `footer.tsx` or `formatEta`. Record DC-05 as PASS with
this rationale. (This is the audit drifting from live code; verify and move on.)

### 6. DC-06 — delete `hasRetryBudget` + `summarizeUnknownError`

In `engine/orchestrator/recovery/builders/shared.ts` (post-B04/B10 shape), delete the two
exported functions `hasRetryBudget` and `summarizeUnknownError`. Zero consumers. Build on
whatever B04/B10 left — find them by name, not by line number.

### 7. DC-07 — narrow `skill-discovery` global/project-dir resolvers

`discoverSkills` (skill-discovery.ts) already routes `codex`→`discoverAgentsMd` and
`aider`→`discoverConventions` at the **top** and returns early, so the `case 'codex'`/
`case 'aider'` arms in `getGlobalDir` and `getProjectDir` are unreachable. For both
functions:
- Delete the `case 'codex': return null;` and `case 'aider': return null;` arms.
- Narrow the return type from `string | null` to `string`.
- Simplify the bodies to: `tool === 'claude-code' ? <claude path> : <diptych path>`.
- Update callers inside `discoverSkills` that handled `null` (the `globalDir`/`projDir`
  null-guards become dead — remove them; they are now always `string`).

### 8. DC-08 — drop the unread `action` payload on `RESOLVE_PENDING_RECOVERY`

- `core/state/types.ts:54`: change
  `| { type: 'RESOLVE_PENDING_RECOVERY'; action: RecoveryAction }`
  → `| { type: 'RESOLVE_PENDING_RECOVERY' }`. If `RecoveryAction` becomes unused in this
  file, drop its import.
- `core/state/machine.ts:372-373`: reducer already ignores `action` (`return { ...state,
  pendingRecovery: undefined }`) — no change there beyond it still type-checking.
- `engine/orchestrator/recovery/actions.ts`: at the **4** dispatch sites (≈lines
  144, 168, 216, 299) remove the `action: opts.action,` property so each dispatch is just
  `{ type: 'RESOLVE_PENDING_RECOVERY' }`. Verify `opts.action` is still used elsewhere in
  `actions.ts` before assuming it's removable from `opts` — it likely still feeds
  `markRecoveryApplying`; leave `opts.action` itself intact, only stop passing it here.

### 9. DC-09 — remove `RunSnapshotLedger.taskId`

`core/schemas/snapshot.ts:44`: delete `taskId: z.string().optional(),` from
`RunSnapshotLedgerSchema`. Verified never written (no `taskId:` literal in
`engine/snapshots/run.ts`) nor read. `taskIndex` (line 45) stays.

### 10. DC-10 — remove `ImplementerOptions.bus`

- `engine/implementers/types.ts`: delete `bus?: EventBus | undefined;` from
  `ImplementerOptions`. If `EventBus` becomes an unused import in that file, remove it.
  (`RetryOptions extends ImplementerOptions` inherits the change automatically.)
- `engine/orchestrator/task/run-implementation.ts`: in the two `.implement({...})` calls
  (≈lines 58-80, the props at lines 65 and 77) delete the `bus: wctx.bus,` property.
  `wctx.bus` is still used for `createBusTextHandler` (line 40) — leave that.
- Verified `bus` is read **nowhere** inside `engine/implementers/`.

### 11. DC-11 — remove `_phaseName` from `runSinglePhasePlanning`

- `engine/planners/planning-helpers.ts`: remove the `_phaseName: string,` param (3rd
  positional) from `runSinglePhasePlanning`. It is unused inside the body.
- `engine/planners/base.ts:166` and `:182`: both call sites pass a literal phase-name
  string as the 3rd arg — delete that argument from each call so positions realign.

### 12. DC-12 — remove vestigial `cost` fields in `stores/workflow/tokens.ts`

Build on B13's version (B13 may have exported `PhaseTokens`/`PerTaskTokens`). The `cost`
field is only ever written `0` and never read off the store type:
- Remove `cost: number;` from `interface PhaseTokens` (line 22) and from
  `interface PerTaskTokens` (line 27).
- `makeEmptyPhaseTokens` (line 98): remove `cost: 0,`.
- `updatedPhase` object (line 156): remove `cost: existingPhase.cost,`.
- The two `?? { totalTokens: 0, cost: 0, title: '' }` defaults (lines 170, 179): remove
  `cost: 0,` from both.
- **Do not touch** `drilldown-overlay.tsx` — its `PhaseRow.cost` (e.g. `if (row.cost > 0)`
  at line 129) is a **different**, computed value (from pricing), not this store field.
  The "never-true `if (row.cost>0)`" in the audit refers to this store's vestigial field,
  which has no such guard in current code — there is nothing to remove there.

### 13. DC-13 (+ cascade) — delete dead tree-store helpers

In `core/sessions/tree/store.ts`:
- Delete `childrenOf` (line 137) and `isOnActivePath` (line 142). Zero production
  consumers.
- **Cascade:** `isOnActivePath` was the only non-test caller of `activePath` (line 133),
  and `activePath` was the only non-test caller of `pathToRoot` (line 121) **after**
  `branch-summary.ts` is deleted in step 1. So delete `activePath` and `pathToRoot` too.
  (Confirm with `rg '\b(activePath|pathToRoot)\b' src --glob '!**/*.test.ts'` returning
  only `store.ts` after step 1.)
- Update `core/sessions/tree/store.test.ts`: remove `activePath`, `childrenOf`,
  `isOnActivePath`, `pathToRoot` from the import block (lines 3-11) and delete the test
  cases that exercise them (lines ~48, 53, 77, 81, 85-86, 102). Keep tests for
  `appendEntry`/`branchFrom`/`createEmptyTree`. (B15 owns broader test reshaping; here you
  only remove what no longer compiles.)

### 14. DC-14 / AS-03 — inline `detectAvailableImplementers`

In `engine/detection/detect.ts`:
- The single call site is `detectAll` at line 138: `detectAvailableImplementers({ providerResults })`.
  Since `providerResults` is always supplied, the `?? detectAvailableProviders()` fallback
  is dead.
- Replace the call at line 138 with `providerResults` directly (it is already the resolved
  array in `detectAll`).
- Delete the `detectAvailableImplementers` function (lines 125-127) and the
  `interface DetectImplementersOptions` (lines 121-123) if it has no other user.

### 15. DC-15 — delete the dead `entry-types` pair (+ orphaned BranchSummary)

In `core/sessions/tree/entry-types.ts`:
- Delete `SessionStartPayloadSchema` + `SessionStartPayload` (lines 5-10) — zero
  consumers.
- Delete `ENTRY_TYPES` (lines 79-87) and `EntryType` (line 88) — zero consumers.
- After step 1, `BranchSummaryPayloadSchema` (lines 67-76) + `BranchSummaryPayload` (line
  77) are orphaned (only `branch-summary.ts`, now deleted, used them) — delete them.
- **Keep** the schemas with real consumers: `PlanStepPayload(Schema)`,
  `AgentInvocationPayload(Schema)`, `RecoveryDecisionPayload(Schema)`,
  `FileStatePayload(Schema)`, `CostCheckpointPayload(Schema)`. Verify each with `rg`
  before deciding. Drop any now-unused imports (`z`, `TaskIdSchema`, enums) only if truly
  unreferenced.
- The audit's alternative ("validate session-start") is **not** chosen — there is no
  wiring that needs it; deletion is correct.

### 16. DC-16 — un-export `publishRecoveryEvent`

`engine/orchestrator/events.ts:202`: change `export function publishRecoveryEvent(` →
`function publishRecoveryEvent(`. Its only users are `publishRecoveryActionSelected`,
`publishRecoveryActionFailed`, `publishRecoveryResolved` in the same file. Build on B06's
post-PD-28 version of the file.

### 17. DC-17 — drop computed-then-overwritten fields / dead branches

- **`engine/orchestrator/auto-split-overflow.ts:~166`** (`childTask` builder): the object
  spreads `...parentWithoutCurrentCode` (which still contains `id`) and then re-sets
  `id: parent.id` — a redundant overwrite with the same value. Remove the explicit
  `id: parent.id` line (the spread already carries `id`). Verify `parent.id ===` the
  spread's id (it is: only `currentCode` was destructured out of `parent`).
- **`engine/claude-invoke.ts:~117`** (`buildClaudeArgs`): both callers (lines ~154, ~184)
  pass `useStdin: true`, so the ternary's `false` branch (`['-p', effectivePrompt, …]`) is
  dead. Simplify: drop the `useStdin` param from `BuildArgsOpts` and from the destructure;
  make `args` unconditionally `['-p', '--output-format', 'stream-json', '--verbose']`.
  **Check the effort path:** `effectivePrompt`/`applyEffortPrefix` are only used in the
  dead false branch. If, after removing the false branch, `effectivePrompt` and
  `applyEffortPrefix` are unreferenced, delete them too. **BUT** if removing them would
  silently drop effort handling that callers rely on, confirm via the callers whether the
  stdin path applies effort elsewhere — if effort is genuinely lost, leave a minimal note
  in your report and prefer the smaller change (drop only the dead branch + `useStdin`
  param, keep `effectivePrompt` unused-check to lint). Do not introduce new behavior.
- **`core/migration/executor.ts`** and **`engine/orchestrator/planner-estimate-review.ts:86`**:
  inspect for a "computed field the caller overwrites." On the current code neither shows
  an obvious dead branch (`executor.ts` writes `migrateState(oldState)` directly;
  `planner-estimate-review.ts:86` is a fixed-shape return). If you find none, record both
  as PASS (no change). Do not invent a refactor.

### 18. DC-18/DC-19/DC-20 — strip dead exports + add the knip gate

These three findings together = "remove dead exports, and add a CI gate so they stay
gone." Hand-listing every dead export is error-prone (several look-alikes have real
consumers — e.g. in `summary.ts`, `Summary`/`CostPrediction`/`CostBreakdown` are heavily
used; only `ChainDriftSummary`/`BriefQualitySummary`/`DriftSummary` are dead). So use
knip as the source of truth:

**18a. Confirmed point deletions (DC-20):** delete these (verified zero consumers):
- `src/utils/type-guards.ts` — `isNonNull` (line 15).
- `src/features/home/logo.ts` — `FULL_LOGO_WIDTH` (line 14).
- `src/engine/streaming/token-utils.ts` — `TokenUsageLike` (line 17).
- `src/core/layout/event-sections.ts` — `DynamicSection` (line 24). **Note:** `core/layout`
  is relocated by B09 (D7) to `features/workflow/layout/`; build on B09's location — find
  `DynamicSection` by name wherever the file now lives.
- `src/stores/ui/command-palette-mru.ts` — `getRank` (line 19). Remove its test reference
  in `command-palette-mru.test.ts` if it breaks compile (B15 owns deeper test work; you
  only fix what won't compile).
- **DO NOT delete `pluralize` in `src/utils/format.ts` (D12 — adopted by B12/B13).**

**18b. Install + configure knip.**
- Add to `package.json` devDependencies: `"knip": "^5"` (use the latest 5.x; run
  `npm install` after editing if the environment allows, otherwise add the dep and let the
  gate's `npx knip` resolve it). Add a script: `"knip": "knip"`.
- Create `knip.json` at repo root:
  ```json
  {
    "$schema": "https://unpkg.com/knip@5/schema.json",
    "entry": ["src/cli.ts", "scripts/check-invariants.ts"],
    "project": ["src/**/*.{ts,tsx}"],
    "ignore": ["**/*.test.ts", "**/*.test.tsx", "src/**/*.d.ts"],
    "ignoreDependencies": [],
    "ignoreExportsUsedInFile": true,
    "includeEntryExports": true
  }
  ```
  Verify the real entry point: it is `src/cli.ts` (the `dev`/`build` scripts use it). If
  `tsx src/cli.ts` is the bin, that single entry is correct. Adjust `entry` only if
  `npx knip` reports the entry itself as unused (it must not).

**18c. Run knip and clean what it reports.**
- Run `npx knip --include exports,types,files`. It will list:
  - **Unused files** — none should remain after step 1 (the session-tree deletes).
  - **Unused exports / exported types** — these are DC-18 (the ~14 dead `z.infer`
    aliases across `summary.ts` + 6 schema files) and DC-19 (the ~30 over-exported
    internals like `handlers.ts:setHandler`).
- For each reported **export**, the fix is to **drop the `export` keyword** (make it
  module-private) when the symbol is still used inside its own file (e.g.
  `handlers.ts:setHandler` is used by the `setAbortHandler` wrappers — un-export it), or
  **delete it** when nothing uses it at all (e.g. dead `z.infer` aliases — delete the
  whole `export type X = z.infer<…>` line).
- For each reported **type**, same rule.
- **Stop-list (D12):** if knip reports any of `pluralize`, `clamp`, `clamp01`,
  `formatPercent`, `formatCost`, `formatKnownCost`, `formatTokensShort`,
  `formatTruncatedList`, `isTerminalPhase`, `isTaskCompleted`, `capitalize`, `wrapHard`,
  `renderMeterBar`, `formatTaskId`, `escapeRegExp`, `cloneDetectedModel`,
  `resolveEditorCommand`, `isPathConfined`, **do NOT delete or un-export them.** Their
  presence in knip's output means B12/B13 left adoption incomplete — record it as a GAP in
  your report so a fix round can complete the adoption. (knip should stay red on these
  only transiently; if your wave gate requires green, you may add a narrow `knip.json`
  `ignore`-comment entry for the specific symbol with a `// adopt-not-delete (D12), see
  B12/B13` note — but prefer reporting the gap.)
- Test-only seams that are legitimately exported for tests (e.g. `_tokensInternal`,
  `__testReset`, `_xxxInternal`, branded-ID constructors) must **not** be removed. If knip
  flags them, add them to a `knip.json` `ignoreExportsUsedInFile`-adjacent allow (use the
  `"ignore"` glob or a per-file `// knip-ignore` if your knip version supports tags). The
  audit scope is "module-private symbols **not** test seams" — keep the seams.

**18d. Add the CI gate (collision: B02 → B14 on `scripts/check-invariants.ts`).**
B02 already added the unsafe-assertion gate to the `gates: Gate[]` array. Append **one
new** `Gate` (do not touch B02's). The existing `Gate` shape is
`{ id, description, command, expected }` and asserts the command's stdout line-count
equals `expected`. Add:
```ts
{
  id: '<next-free-id>',
  description: 'No dead exports/files (knip)',
  command: 'npx knip --no-progress --reporter compact 2>/dev/null | rg . | wc -l',
  expected: 0,
},
```
Pick `<next-free-id>` as the next unused id in the array (read the file first). Confirm
the command returns `0` after 18c. If knip's compact reporter prints a header even when
clean, adjust the `rg`/grep filter so a clean run yields exactly 0 lines (e.g.
`rg -v '^$'` or grep for the actual issue-line pattern). **The gate MUST be 0 before you
declare done.**

### 19. Final cascade sweep

After all deletions, run `npm run typecheck` and `npx knip` once more. Fix any remaining
orphans they surface (new unused imports, newly-dead helpers). Repeat until both are
clean (respecting the D12 stop-list).

## Out of scope (owned elsewhere — do NOT touch)

- `formatPercent`/`formatCostFact` extraction in `recovery/builders/shared.ts` → **B04**.
- Splitting `recovery/builders/shared.ts` → **B10**. You only delete two functions there.
- `machine.ts` switch exhaustiveness / `transition` opts / REWIND dedup → **B02/B08/B12**.
  You only drop the `RESOLVE_PENDING_RECOVERY.action` payload.
- `stores/workflow/tokens.ts` `PhaseTokens`/`PerTaskTokens` **export + derive** (DRY-24)
  → **B13**. You only delete the `cost` fields.
- `core/layout/` relocation + `LayoutEvent` deletion (D7) → **B09**. For DC-20's
  `DynamicSection`, find the file at its B09 location; do not relocate it yourself.
- The unsafe-assertion invariants gate (D1) in `check-invariants.ts` → **B02**. You only
  append the knip gate.
- `publishRecoveryEvent` param objects (PD-28) → **B06**. You only drop `export`.
- DRY-30's `branch-summary` extractor → **MOOTED by your DC-01 (D11)**; B12 owns the
  remaining 3 extractors. Do not add an extractor in the deleted tree.
- Any deeper test restructuring (split/relocate/glyph→structural) → **B15**. You only
  remove test code that no longer compiles after a deletion (`store.test.ts`,
  `command-palette-mru.test.ts` references).
- **Do NOT delete `cost/footer.tsx`/`formatEta`** (DC-05 is not dead — PASS).
- **Do NOT delete/un-export any D12 adopt-not-delete helper** (`pluralize` et al.).

## Acceptance criteria

- [ ] Every finding ID above is addressed in the code (DC-01..20, AS-03), with DC-05
  recorded PASS (no change, rationale: live consumers) and DC-17 executor/estimate-review
  sub-items recorded PASS if no dead branch exists.
- [ ] The 6 DC-01 files are deleted; `rg 'branch-summary|summary-prompt|branch-context'
  src --glob '!*.md'` returns nothing; `reconstructTree` (io.ts) and
  `branchFrom`/`appendEntry`/`createEmptyTree` (store.ts) still exist.
- [ ] `validate-and-commit.ts`: `preApprovedChangedFiles` is required; the
  `=== undefined` branch and its now-unused imports are gone; `step.ts`/`step.test.ts`
  still compile.
- [ ] `store.ts` no longer exports `childrenOf`/`isOnActivePath`/`activePath`/`pathToRoot`;
  `store.test.ts` no longer imports or tests them.
- [ ] `RESOLVE_PENDING_RECOVERY` action type carries no `action`; the 4 dispatch sites in
  `recovery/actions.ts` no longer pass it.
- [ ] `ImplementerOptions.bus`, `RunSnapshotLedger.taskId`, `_phaseName`,
  `PhaseTokens.cost`/`PerTaskTokens.cost`, `RESOLVE_PENDING_RECOVERY.action`,
  `createClient`, `MarkdownBlock`, `hasRetryBudget`, `summarizeUnknownError`,
  `detectAvailableImplementers`, `isNonNull`, `FULL_LOGO_WIDTH`, `TokenUsageLike`,
  `DynamicSection`, `getRank` are all gone; their call sites are updated.
- [ ] `skill-discovery` `getGlobalDir`/`getProjectDir` return `string` (no `| null`) and
  have no `codex`/`aider` arms.
- [ ] `pluralize` and all D12 helpers are **untouched** (still present).
- [ ] `knip` is installed, `knip.json` exists, `npx knip` reports zero dead files/exports
  (modulo the documented test-seam ignores and D12 stop-list), and a new knip `Gate`
  exists in `scripts/check-invariants.ts` returning `expected: 0`.
- [ ] No new `!`/broad `as`/`any`/barrels/non-Error classes/memoization; `.js` imports;
  `engine/` does not import `react`/`ink`/`features`; no decorative comments introduced.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (those touching the deleted/edited modules).

## Tests

```bash
# Targeted areas touched by deletions/edits:
npm test -- src/core/sessions/tree src/engine/orchestrator/escalation \
  src/engine/orchestrator/recovery src/engine/planners src/engine/detection \
  src/stores/workflow src/core/state src/engine/snapshots src/engine/implementers \
  src/core/migration

# Dead-code gate:
npx knip
npm run check:invariants

# Standing gates:
npm run typecheck
npm run lint
```
