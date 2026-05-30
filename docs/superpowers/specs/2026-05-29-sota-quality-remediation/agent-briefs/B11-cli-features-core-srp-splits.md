# B11 — CLI / features / core SRP file splits

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Split five oversized, mixed-concern files in the CLI / features / core tree so each file
holds one responsibility, and relocate three pieces of UI/phase logic that live below
their only consumers. Concretely: turn `cli/commands/start.ts`'s 140-line god-callback
into `bootstrapSession` + four per-mode dispatchers; split the residual pure-formatter
`features/workflow/components/brief-review.ts` into `brief-review-format.ts` (pure) +
`plan-review-metadata.ts` (store-reading coordinator); extract the pure config
path-projection out of `stores/project/config.ts` into `config-persistence.ts`; relocate
`core/settings/presentation.ts` into the settings feature and move the command-registry
phase predicates into `core/phases.ts`; extract the registry result-message formatting
into `core/runtime/commands/messages.ts` and stop discarding two handler errors; and move
`engine/export/html-renderer.ts`'s CSS into `report-styles.ts` while collapsing its two
near-identical scored-result renderers into one. Behavior is unchanged except the two
registry handlers now surface their real error message.

## Wave / ordering

- **Wave:** 6. **Runs after:** **B08** and **B09** (and transitively B01–B07).
  - After **B08** because B08 makes the parameter-object fixes inside `cli/commands/start.ts`
    (flag handling) and `stores/project/config.ts` (`persistedValue`/`persistedConfig` param
    objects, PD-36). B11 then moves that already-fixed code — never revert B08's signatures.
  - After **B09** because B09 relocates the engine routing logic out of `brief-review.ts`
    into the new `engine/facades/routing-preview.ts` (D6, AR-05). B11 only splits the
    **pure-formatter residue** that remains. B09 also relocates `core/layout/` (D7) and the
    `createCommandContext` factory; B11 does not touch layout.
- **Decisions that bind this brief:**
  - **D6** — the lone facade: `engine/facades/routing-preview.ts` is **B09's**, not yours.
    Any engine routing code still in `brief-review.ts` is B09 residue; if you find it, leave
    its relocation to B09 (mark PASS) and split only what is pure formatting + store reads.
  - **D12** — ADOPT-NOT-DELETE: do not delete `isTerminalPhase`/`pluralize`/`formatPercent`/
    `isTaskCompleted` etc. You only **move** phase predicates into `core/phases.ts`; you do
    not delete any helper there.

## File ownership

**Edit / split (yours):**
- `src/cli/commands/start.ts` — extract `bootstrapSession` + `runDetachedStart` /
  `runJsonStart` / `runRpcStart` / `runInteractiveStart` (SRP-05, DRY-13). **Shared with
  B08** (B08 → B11): B08 owns the flag-validation parameter fixes; you own only the
  god-callback extraction. Build on B08's edits.
- `src/stores/project/config.ts` — extract the pure path-projection into a new
  `config-persistence.ts` (SRP-13). **Shared with B02 + B08** (B02 → B08 → B11): B02 owns
  cast removal, B08 owns `persistedValue/Config` param objects; you own only the
  file-extraction. Build on their edits.
- `src/core/runtime/commands/registry.ts` — move phase predicates to `core/phases.ts`
  (FO-03), extract result messages to `commands/messages.ts` (SRP-16), fix the two
  error-discard handlers (EH-15). **Shared with B02** (B02 → B11): B02 owns the
  `navigate`/switch exhaustiveness; you own the predicate move + messages + EH-15.
- `src/features/workflow/components/brief-review.ts` — split into `brief-review-format.ts`
  + `plan-review-metadata.ts` (SRP-03, FO-02). **Shared with B09** (B09 → B11): B09 owns
  moving the engine routing logic to the facade; you own splitting the pure-formatter
  residue. Build on B09's edits.
- `src/core/settings/presentation.ts` — relocate into the settings feature (SRP-17, FO-03).
- `src/engine/export/html-renderer.ts` — extract CSS to `report-styles.ts` (FO-05); merge
  the two scored-result renderers (DRY-62).

**Create (yours):**
- `src/features/workflow/components/brief-review-format.ts`
- `src/features/workflow/components/plan-review-metadata.ts`
- `src/stores/project/config-persistence.ts`
- `src/core/runtime/commands/messages.ts`
- `src/features/settings/presentation.ts`
- `src/engine/export/report-styles.ts`

**Delete (yours, after move):**
- `src/features/workflow/components/brief-review.ts` (its symbols re-homed into the two new
  files; delete only once every importer is repointed and no symbols remain).
- `src/core/settings/presentation.ts` (after relocation; update its 3 importers).

**Call-site / test files you must update (not split):**
- `src/features/workflow/components/plan-editor.tsx`,
  `src/features/workflow/components/plan-editor/task-row.tsx`,
  `src/features/workflow/components/plan-editor/loader.ts`,
  `src/features/workflow/components/plan-editor/preview-panel.tsx`,
  `src/features/workflow/components/brief-review-view.tsx`,
  `src/features/workflow/components/brief-review-view.test.ts` — repoint imports off
  `brief-review.js` to the new module(s).
- `src/features/settings/overlay.tsx`,
  `src/features/settings/hooks/buffer.ts`,
  `src/features/settings/hooks/editor.ts` — repoint to the relocated `presentation.js`.
- `src/core/runtime/commands/registry.test.ts` — repoint the phase-predicate imports.
- `src/cli/commands/start.test.ts` — must keep passing unchanged (behavior preserved).
- `src/engine/export/html-renderer.test.ts`,
  `src/engine/export/collect.ts` — no path change (CSS extraction is internal to the
  module); verify still green.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| SRP-05 | high | `cli/commands/start.ts:112-254` | Extract `bootstrapSession(opts)` + `runDetachedStart`/`runJsonStart`/`runRpcStart`/`runInteractiveStart`; the `.action` callback only validates flags then dispatches. (= DRY-13) |
| DRY-13 | high | `cli/commands/start.ts:140-231` | The readiness→begin-session→persist sequence duplicated across the 4 modes collapses into `bootstrapSession`. (= SRP-05) |
| SRP-03 | high | `features/workflow/components/brief-review.ts:1-238` | Split into `brief-review-format.ts` (pure) + `plan-review-metadata.ts` (store-reading coordinator). |
| FO-02 | high | `features/workflow/components/brief-review.ts:17-237` | Non-component logic must leave `components/` as plain `.ts` modules. (= SRP-03) |
| SRP-13 | med | `stores/project/config.ts:43-112` | Extract the pure path-projection algorithm into `config-persistence.ts`; the store keeps only `load`/`save`/`use…` glue. |
| SRP-16 | med | `core/runtime/commands/registry.ts:414-446` | Extract result-message formatting from handler closures into `core/runtime/commands/messages.ts`. |
| FO-03 | med | `core/runtime/commands/registry.ts:11-27` | Move `phaseOrder`/`canReviseSpec`/`canRevisePlan`/`canRedoTask` into `core/phases.ts`. |
| SRP-17 | med | `core/settings/presentation.ts:9-44` (+`registry.ts`) | Relocate `presentation.ts` into the settings feature; phase predicates → `core/phases.ts` (layout is B09's). |
| EH-15 | low | `core/runtime/commands/registry.ts:152-153,314-315` | `/refresh` and `/repomap rebuild` must surface `toErrorMessage(err)` instead of discarding it. |
| FO-05 | low | `engine/export/html-renderer.ts:7-131` | Move the `CSS` constant into `report-styles.ts`. |
| DRY-62 | low | `engine/export/html-renderer.ts:228-242` | Collapse `renderDrift`/`renderBriefQuality` into one `renderScoredResult(title, result)`. |

Cross-check vs Coverage summary B11 = `SRP-03,05,13,16,17; FO-02,03,05; EH-15; DRY-13,62`.
All 11 rows are present above. (Note: `SRP-17` and `FO-03` overlap on the phase-predicate
move — do it once, satisfies both. `SRP-05` and `DRY-13` overlap on the `start.ts` split —
do it once, satisfies both.)

## Required changes

> First, for every file below, **open the current source** — B01 reflowed formatting
> (single quotes, 2-space indent), B02/B08 changed signatures in `config.ts`/`start.ts`,
> and B09 moved engine routing out of `brief-review.ts`. Match the live code, not the line
> numbers in this brief.

### 1. `brief-review.ts` → `brief-review-format.ts` + `plan-review-metadata.ts` (SRP-03, FO-02)

Read `src/features/workflow/components/brief-review.ts` as it stands **after B09**. The loop
is serialized and B09 is validated `clean` before B11 starts, so the post-B09 baseline is
**the** state you will see: B09 has already relocated the engine routing logic
(`buildRoutingPreviewMetadata`, `refreshTaskForRoutingPreview`, `routingPreviewReason`, and
the fabricated `ProjectContext`) into `engine/facades/routing-preview.ts` (D6/AR-05) and
has already repointed `preview-panel.tsx` to that facade. What remains in `brief-review.ts`
is pure formatters plus the store-reading wrapper `refreshPlanReviewMetadata` (which now
calls the facade's builder). Split that residue per the steps below and **delete the file**.

**Flag-stop (do not ship a partial split):** if you still find routing assembly in
`brief-review.ts` — i.e. an import of `routeTaskToImplementerProfile` from
`engine/orchestrator/context-routing/route.js`, `buildProjectLanguageContext`, or a
hand-built `ProjectContext` with `name:'unknown'`/`runtime:'node'` — that means B09 is
incomplete. **Stop and report it**; do not re-home routing into a facade yourself (that is
B09's job, D6) and do not proceed with a half-split. The normal path has none of these
imports left in the file.

Create **`src/features/workflow/components/brief-review-format.ts`** holding the **pure**
formatters and their private helpers (no `node:fs`, no `configStore`, no engine imports):
- `formatQualityDisplay`
- `hasTaskReviewWarning` (+ private `hasBlockingReviewState`)
- `getTaskStatusSymbol`
- `buildTaskDetailParts`
- `formatTaskCount`
- `formatContextFit`
- `formatTaskReviewLine` (+ private `inferValidationStatus`, `inferRisk`)
- `formatPlanReviewSummary`
- the `COST_TIER_ORDER` const

Keep the type-only imports these need: `Task` from `core/schemas/task.js`,
`BriefQualityIssue`/`BriefQualityReport` from `engine/spec/brief-quality.js`,
`PlanReviewCostTier`/`PlanReviewRisk`/`PlanTaskReviewMetadata` from
`stores/workflow/plan-editor.js`, and `uniqueSorted` from `utils/collections.js`. These are
all type imports or a pure util — no layering violation.

Create **`src/features/workflow/components/plan-review-metadata.ts`** holding the
**store-reading coordinator**:
- `refreshPlanReviewMetadata(tasks)` — reads `configStore.get()`, returns `null` if no
  config, otherwise delegates to the metadata builder. The builder is B09's facade function;
  import it from `engine/facades/routing-preview.js` (confirm the exact exported name and
  path against B09's facade — read the facade file). This is a UI → engine-facade import,
  which is exactly the boundary D6 establishes — allowed.

Then **repoint all importers** and delete `brief-review.ts`:
- `plan-editor.tsx:9-13` imports `{ formatPlanReviewSummary, formatQualityDisplay,
  formatTaskCount }` → from `./brief-review-format.js`.
- `plan-editor/task-row.tsx:6-12` imports `{ buildTaskDetailParts, formatContextFit,
  formatTaskReviewLine, getTaskStatusSymbol, hasTaskReviewWarning }` → from
  `../brief-review-format.js`.
- `plan-editor/loader.ts:7` imports `{ refreshPlanReviewMetadata }` → from
  `../plan-review-metadata.js`.
- `plan-editor/preview-panel.tsx:13` imports `{ refreshTaskForRoutingPreview }` — this is a
  routing function that B09 already moved to and repointed at the facade. On the normal
  (post-clean-B09) path this importer no longer references `brief-review.js` at all, so there
  is nothing for you to repoint here. If it still imports from `brief-review.js`, that is the
  incomplete-B09 flag-stop above — stop and report.
- `brief-review-view.tsx:12-20` imports `{ buildTaskDetailParts, formatPlanReviewSummary,
  formatQualityDisplay, formatTaskCount, formatTaskReviewLine, getTaskStatusSymbol }` →
  `./brief-review-format.js`; and `{ refreshPlanReviewMetadata }` → `./plan-review-metadata.js`.
- `brief-review-view.test.ts:5-12` imports `{ formatQualityDisplay, formatTaskReviewLine,
  getTaskStatusSymbol, buildTaskDetailParts, formatTaskCount }` → `./brief-review-format.js`
  and `{ refreshPlanReviewMetadata }` → `./plan-review-metadata.js`. The same test also
  imports `{ buildRoutingPreviewMetadata }`; on the post-B09 path B09 has already repointed
  that to the facade (`engine/facades/routing-preview.js`). If the test still imports
  `buildRoutingPreviewMetadata` from `./brief-review.js`, repoint it to the facade path to
  keep the test compiling. Do not change any assertions.

Then **delete `src/features/workflow/components/brief-review.ts`** (unconditionally — its
symbols are now re-homed). Find any straggler imports with:
`grep -rn "/brief-review.js" src/` (must return nothing once done; note `brief-review-view.js`
and `brief-review-scorecard.js` are different files and stay). `find src/features/workflow/components -name 'brief-review.ts'`
must return nothing (only `brief-review-view.tsx`, `brief-review-format.ts`,
`plan-review-metadata.ts` remain).

### 2. `cli/commands/start.ts` → `bootstrapSession` + 4 dispatchers (SRP-05, DRY-13)

Read the current `registerStartCommand` `.action` callback. The four launch modes
(`--detach`, `--json`, `--rpc`, interactive) each repeat: `collectReadiness` →
`assertReadinessCanStart` → `clearStaleSessionForCli` (json/rpc/interactive) →
`beginSession`/`generateSessionId` → `persistStartReadiness`. Extract a shared helper and
four dispatchers, all module-scoped functions in the same file:

- `async function bootstrapSession(args): Promise<{ sessionId, readiness } | …>` —
  encapsulate the **shared** readiness-gate + session-begin + persist sequence. Choose the
  parameter object shape from the real callback (it needs `projectDir`, `feature`, `opts`,
  and the readiness-collection options that differ per mode, e.g. `defaultAutoApprove` for
  json). Return the values each dispatcher needs. Reuse the existing `persistStartReadiness`,
  `assertReadinessCanStart`, `clearStaleSessionForCli` helpers (do not duplicate them).
- `async function runDetachedStart(...)` — the `opts.detach` block (lines ~140-175): migrate,
  ensure git/config, gate readiness, `generateSessionId` + `ensureSessionDir` +
  `persistStartReadiness`, build overrides, `deps.spawnServer`, print result. Detach uses
  `generateSessionId`+`ensureSessionDir` (not `beginSession`), so it may call only the
  readiness-gate part of `bootstrapSession` or inline that step — keep its current behavior
  exactly (it must still create artifacts in the worktree path and persist overrides).
- `async function runJsonStart(...)` — the `opts.json` block (lines ~181-199): writes the
  `readiness_report` line to stdout, `bootstrapSession` with `defaultAutoApprove: true`,
  `deps.runHeadless`.
- `async function runRpcStart(...)` — the `opts.rpc` block (lines ~201-219): writes readiness
  via `createResponseWriter(process.stdout).status(...)`, `bootstrapSession`, `deps.runRpc`.
- `async function runInteractiveStart(...)` — the trailing block (lines ~221-253):
  `setupWorkflow`, conditional readiness, `bootstrapSession` (only when `feature && !needsSetup`),
  `deps.initStores`, `detectWorktree`, `routerStore.init(...)`, `deps.renderApp`.

The `.action` callback then: runs the flag-combination validation (B08's code — keep it),
`applyWorktreeOption`, the `@file` parse block, resolves `projectDir`, runs migration, and
dispatches to exactly one of the four functions. Pass `deps` (the `StartDeps`) and parsed
inputs (`feature`, `enrichedFeature`, `plannerContext`, `opts`) into each dispatcher.

Preserve every observable behavior the existing `start.test.ts` asserts (35 tests):
worktree-before-detach ordering, flag-combo rejections before any worktree creation,
readiness emission order (readiness line/status **before** workflow execution), compact
session evidence persistence, `worktreeName` passthrough, default-command shorthand, and
`@file` → `plannerContext` separation. Do **not** change `StartDeps`,
`registerStartCommand`'s exported signature, or any string/exit-code. `start.test.ts` must
pass unchanged.

### 3. `stores/project/config.ts` → `config-persistence.ts` (SRP-13)

Read the current file (B02 removed casts; B08 reshaped `persistedValueForSave`/
`persistedConfigForSave` into param objects — keep those shapes). Move the **pure**
path-projection algorithm into a new `src/stores/project/config-persistence.ts`:
- `type Path` (the `readonly string[]` alias) — export it.
- `cloneConfig`, `cloneValue`
- `parseChangedPaths`, `isPathPrefix`, `pathIntersectsChangedPath`
- `persistedValueForSave`, `persistedConfigForSave` (exported — the store calls
  `persistedConfigForSave`), `setPath`
- the `SaveOptions` interface (move or re-export so both files type-check)

`config.ts` keeps: the store state/`createStore`, `SaveResult`, `load`, `save`, `useConfig`,
`setContextLength`, `setApprovalEnabled`, `__testReset`, and the exported `configStore`.
`save` imports `persistedConfigForSave` (and `cloneConfig` if still needed) from
`./config-persistence.js`. The new file imports `Config` from `core/schemas/config.js`,
`isRecord` from `utils/type-guards.js`, `deepEqual` from `utils/deep-equal.js`. No store
import in `config-persistence.ts` — it must stay pure (the SRP point). Re-run
`grep -rn "project/config.js" src/` to confirm no external importer depended on the moved
internal symbols (they were not exported, so none should).

### 4. `core/runtime/commands/registry.ts`: phase predicates → `core/phases.ts` (FO-03/SRP-17), messages → `commands/messages.ts` (SRP-16), EH-15

**4a. Move phase predicates into `core/phases.ts`.** Move `phaseOrder`, `canReviseSpec`,
`canRevisePlan`, `canRedoTask` (and the `TERMINAL` set they share) from `registry.ts` into
`src/core/phases.ts` (which already exists). Export all four. Notes:
- `core/phases.ts` already has a `TERMINAL`-like notion? It does **not** export an `idle`+
  `complete` set today — add a module-private `const TERMINAL: ReadonlySet<Phase> = new Set(['idle','complete'])` if not present, or reuse `isTerminalPhase` if B04 added it (D12: B04
  promotes `isTerminalPhase` to `core/phases.ts`). Prefer `!isTerminalPhase(phase)` over a
  duplicate set if `isTerminalPhase` exists — do not create a second terminal-phase set.
- `registry.ts` imports `{ canReviseSpec, canRevisePlan, canRedoTask }` (and `phaseOrder` if
  still referenced) from `../../phases.js`. It uses them in `phaseGuard:` fields and the
  `/redo-task` handler's `canRedoTask(phase)` check.
- Repoint `registry.test.ts:2` — it imports `{ createRuntimeCommands, canReviseSpec,
  canRevisePlan, canRedoTask } from './registry.js'`. Split: keep `createRuntimeCommands`
  from `./registry.js`; import the three predicates from `../../phases.js` (path:
  `../../phases.js` relative to `core/runtime/commands/`). Do not change the assertions.

**4b. Extract result messages into `core/runtime/commands/messages.ts` (SRP-16).** The audit
points at the `/reject-run` handler (lines ~414-446) whose closure builds a multi-clause
result message (`changedCount`/`conflictText`/`missingText`/`message`). Create
`src/core/runtime/commands/messages.ts` exporting pure formatters that take the result
object and return the display string, e.g.:
- `formatRejectRunMessage(result: Extract<RejectRunSnapshotResult, { status: 'rejected' }>): string`
  returning the `Run rejected from snapshot …` string.
- (Optionally also fold the other handlers' inline message construction that is non-trivial,
  e.g. `/queue` depth/cleared pluralization and `/compact-transcript` summary — only if it
  reduces closure logic; keep it minimal and pure. The `/reject-run` extraction is the
  mandated one.)

Import the type(s) from `./types.js` (`RejectRunSnapshotResult` is exported there). The
handler closure then computes `result`, branches on `status`, and calls the formatter for
the message text; the closure still decides `setFeedbackError` vs `setFeedbackMessage`
(that is UI dispatch, not formatting — keep it in the handler). Keep behavior byte-identical
to the current string output.

**4c. EH-15 — stop discarding handler errors.** Two `catch` blocks ignore the error:
- `/refresh` handler (~line 152): `catch { ctx.setFeedbackError('Tool detection failed'); }`
  → `catch (err) { ctx.setFeedbackError(toErrorMessage(err)); }` (or
  `` `Tool detection failed: ${toErrorMessage(err)}` `` if you want to keep the prefix —
  prefer the bare `toErrorMessage(err)` to match the 4 sibling handlers that already do
  exactly `ctx.setFeedbackError(toErrorMessage(err))`).
- `/repomap rebuild` handler (~line 314):
  `catch { ctx.setFeedbackError('Failed to clear repomap cache.'); }` →
  `catch (err) { ctx.setFeedbackError(toErrorMessage(err)); }`.

`toErrorMessage` is already imported at the top of `registry.ts` (from
`../../../utils/format-errors.js`). Use the same import; do not add a second.

### 5. `core/settings/presentation.ts` → `features/settings/presentation.ts` (SRP-17/FO-03)

Move the whole file `src/core/settings/presentation.ts` to
`src/features/settings/presentation.ts`. It exports `SettingsPresentationColors`,
`valueColor`, `matchesFilter`, `validateNumber`, `displayValue`, and imports
`type { SettingDef } from './catalog.js'` — after the move that import becomes
`from '../../core/settings/catalog.js'`. Repoint the 3 importers:
- `features/settings/overlay.tsx:9` `from '../../core/settings/presentation.js'` →
  `from './presentation.js'`.
- `features/settings/hooks/buffer.ts:8` `from '../../../core/settings/presentation.js'` →
  `from '../presentation.js'`.
- `features/settings/hooks/editor.ts:8` `from '../../../core/settings/presentation.js'` →
  `from '../presentation.js'`.

Delete `src/core/settings/presentation.ts`. Confirm with
`grep -rn "core/settings/presentation" src/` (must return nothing).

### 6. `engine/export/html-renderer.ts`: CSS → `report-styles.ts` (FO-05) + merge scored renderers (DRY-62)

**6a.** Move the module-level `const CSS = \`…\`` (the ~125-line template string) into a new
`src/engine/export/report-styles.ts` exporting it, e.g.
`export const REPORT_CSS = \`…\`;`. In `html-renderer.ts` import it
(`import { REPORT_CSS } from './report-styles.js';`) and use it in the `<style>${REPORT_CSS}</style>`
slot of `renderSessionHtml`. No other behavior change.

**6b.** Collapse `renderDrift(drift: DriftExport)` and `renderBriefQuality(briefQuality:
BriefQualityExport)` — they are identical except the `<h2>` title (`Drift` vs `Brief
quality`) — into one helper:
```
function renderScoredResult(title: string, result: DriftExport | BriefQualityExport): string
```
returning the same `<section class="report-section"><h2>${title}</h2><p><span class="score
${getResultTone(result)}">${result.score.toFixed(2)}</span>${result.passed ? 'Passed' :
'Failed'}</p><p class="muted">${result.errorCount} errors · ${result.warningCount}
warnings</p></section>` markup. `getResultTone` already accepts `DriftExport |
BriefQualityExport`. Update the two call sites in `renderSessionHtml`:
- `${data.drift ? renderDrift(data.drift) : ''}` → `${data.drift ? renderScoredResult('Drift', data.drift) : ''}`
- `${data.briefQuality ? renderBriefQuality(data.briefQuality) : ''}` →
  `${data.briefQuality ? renderScoredResult('Brief quality', data.briefQuality) : ''}`

Delete the now-unused `renderDrift`/`renderBriefQuality`. `html-renderer.test.ts` and
`collect.ts` need no path change; verify they pass.

## Out of scope (owned elsewhere — do NOT touch)

- `engine/facades/routing-preview.ts` and the engine routing logic in `brief-review.ts`
  (`buildRoutingPreviewMetadata`, `refreshTaskForRoutingPreview`, `routingPreviewReason`,
  fabricated `ProjectContext`), and `worker-packet-preview.ts`, `preview-panel.tsx`'s
  re-run-routing block → **owned by B09** (D6, AR-05, AR-11, SRP-04). You only repoint
  imports after B09 moved them.
- `engine/facades/recovery.ts` deletion, `createCommandContext` relocation,
  `build-rewind-action` move, `core/evidence/ledger.ts`, `core/layout/` relocation,
  `predictCost` cache, `features/summary/screen.tsx` facade, `stores/workflow/tokens.ts`
  attribution → **owned by B09**.
- The `navigate`/closed-union switch exhaustiveness in `registry.ts`, the cast removal in
  `config.ts` → **owned by B02**. Do not re-fix; build on them.
- `persistedValue/Config` parameter-object shapes in `config.ts`, the flag-validation
  parameter fixes in `start.ts`, `core/layout/*` param objects, `NM-01`
  `computeScrollWindow` → **owned by B08**. Keep their signatures; do not revert.
- `core/phases.ts` helper *creation* (`isTerminalPhase`, `clamp`, etc.) → **owned by B04**.
  You only **add** the four phase predicates; do not delete or rewrite B04's helpers.
- Engine SRP splits (`snapshots/store.ts`, `planning/shared.ts`, `output-parsers.ts`,
  `pricing.ts`→`cost.ts`, `repomap.ts`, `mcp/resolver.ts`, etc.) → **owned by B10**.
- DRY adoption sweeps (`renderTable`, `resolveRunConfig`, `resumeSavedSession`,
  `useBriefData`, `classifyReviewMetadata`, `withCliErrors`, etc.) → **owned by B12/B13**.
  In particular do **not** build `useBriefData` (DRY-16, B13) or `classifyReviewMetadata`
  (DRY-48, B13) here — your job is the structural split only.

## Acceptance criteria

- [ ] Every finding ID above (SRP-03, SRP-05, SRP-13, SRP-16, SRP-17, FO-02, FO-03, FO-05,
  EH-15, DRY-13, DRY-62) is addressed in the code.
- [ ] `cli/commands/start.ts`'s `.action` callback no longer inlines the four mode bodies;
  `bootstrapSession`, `runDetachedStart`, `runJsonStart`, `runRpcStart`,
  `runInteractiveStart` exist and the readiness→begin→persist sequence is written once.
  `start.test.ts` passes unchanged.
- [ ] `features/workflow/components/brief-review.ts` is **deleted**; `brief-review-format.ts`
  (pure: no `node:fs`, no `configStore`, no `engine/orchestrator`/`engine/spec` value
  imports) and `plan-review-metadata.ts` exist; every former importer points at the right
  new module. `grep -rn "/brief-review.js" src/` returns nothing.
- [ ] `stores/project/config-persistence.ts` holds the path-projection (no store import) and
  `config.ts` imports `persistedConfigForSave` from it; `config.ts` no longer defines the
  projection functions.
- [ ] `phaseOrder`/`canReviseSpec`/`canRevisePlan`/`canRedoTask` live in `core/phases.ts`
  and are imported by `registry.ts` + `registry.test.ts`; no duplicate terminal-phase set if
  `isTerminalPhase` is available.
- [ ] `core/runtime/commands/messages.ts` exists and `/reject-run`'s message string is built
  there; the handler still chooses error-vs-message dispatch.
- [ ] `/refresh` and `/repomap rebuild` handlers surface `toErrorMessage(err)`; no empty
  `catch {}` remains in those two handlers.
- [ ] `core/settings/presentation.ts` is deleted; `features/settings/presentation.ts` exists
  and its 3 importers are repointed. `grep -rn "core/settings/presentation" src/` returns
  nothing.
- [ ] `engine/export/report-styles.ts` exports the CSS; `html-renderer.ts` imports it; one
  `renderScoredResult(title, result)` replaces `renderDrift`/`renderBriefQuality`.
- [ ] No new `!`/broad `as`/`any`/barrels (no re-export-only `index.ts`)/non-`Error`
  classes/memoization (`useMemo`/`useCallback`/`React.memo`); all imports use the `.js`
  extension; `engine/` does not import `react`/`ink`/`features`/`components`/`hooks`; no
  decorative comments or section banners in the new files.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (`start.test.ts`, `config.test.ts`, `registry.test.ts`,
  `brief-review-view.test.ts`, `html-renderer.test.ts`, settings tests). Update test import
  paths where files moved; do not change assertions.
- [ ] If routing assembly (`routeTaskToImplementerProfile` / fabricated `ProjectContext`)
  is still present in `brief-review.ts`, the implementer **stops and reports an incomplete
  B09** rather than shipping a partial split.

## Tests

```bash
npm test -- src/cli/commands/start.test.ts \
            src/stores/project/config.test.ts \
            src/core/runtime/commands/registry.test.ts \
            src/features/workflow/components/brief-review-view.test.ts \
            src/features/settings \
            src/engine/export/html-renderer.test.ts \
            src/engine/export/collect.test.ts
npm run typecheck
npm run lint
```
