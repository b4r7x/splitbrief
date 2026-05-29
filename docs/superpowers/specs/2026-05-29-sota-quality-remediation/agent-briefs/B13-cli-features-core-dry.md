# B13 — CLI / features / core DRY extractions & adoption

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Collapse the duplicated CLI/UI/core glue that the audit flagged on the non-engine side:
extract a shared CLI table renderer, a shared config-resolution helper, a shared
resume/continue tail, an error-wrapping helper, an NDJSON/JSON-line helper pair, a
prompt-channel factory, and a private session-tree insert helper; share the router's
per-screen payloads and the cost-drilldown store types; consolidate the contradictory
status→glyph maps and the review-metadata classification predicates into one source each;
and **adopt** the helpers that B04 produced in Wave 2 (`pluralize`, `formatTaskId`,
`wrapHard`, `renderMeterBar`, `resolveEditorCommand`, `cloneDetectedModel`,
`computeScrollWindow`, `clampIndex`, `DIPTYCH_DIR`/`getDiptychPath`) across the CLI and
TUI. Net result: the CLI/features/core tree expresses each of these rules once, with no
behavior change except where a finding's fix is explicitly a bugfix.

## Wave / ordering

- **Wave:** 7. **Runs after:** **B04** (the producer wave — every helper this brief
  *adopts* must already exist) and **B11** (the CLI/features/core SRP splits — `start.ts`
  is split into `bootstrapSession`+dispatchers, `brief-review.ts` is split into a pure
  formatter + `plan-review-metadata.ts`, `registry.ts` predicates moved to `core/phases.ts`).
  B13 runs **in parallel with B12** (engine DRY) — disjoint files, serialized writes; do
  not wait on B12. Several rows also depend on earlier waves whose work must already be in
  the tree: **B08** fixed `computeScrollWindow`/`clampIndex` semantics to a *cap* (D5);
  **B05** converted `cli/errors.ts` to `class CliError extends Error` (D2); **B09**
  relocated `core/layout/` into `features/workflow/layout/` and moved the engine routing
  logic out of `brief-review.ts`/`worker-packet-preview.ts` into
  `engine/facades/routing-preview.ts`.
- **Decisions that bind this brief:**
  - **D12** — `pluralize`, `clamp`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`,
    `formatTaskId`, `wrapHard`, `renderMeterBar`, `resolveEditorCommand`,
    `cloneDetectedModel` are **ADOPT-NOT-DELETE**. Your adoption (DRY-08b, 47, 65, 68, 69,
    70) is what makes them non-dead; B14 must not delete them. Do not "tidy" them away.
  - **D2** — `cli/errors.ts` exports `class CliError extends Error` (added by B05). Your
    `withCliErrors` builds **on top of** that file; never revert it to the old
    `Object.assign` form.

## File ownership

You **edit** these (build on prior briefs' versions; read the live file first):

- `src/cli/commands/ps.ts`, `worktree.ts`, `approval.ts` — route table output through the
  new `renderTable` (DRY-12 = KISS-05).
- `src/cli/errors.ts` — **add** `withCliErrors`. **Collision (not in the coordinator map —
  read this):** owned by **B05** (EH-13/D2). By Wave 7 it already exports
  `class CliError extends Error`, `cliError`, `isCliError`, `rethrowAsCli`. Add your
  helper; touch nothing B05 wrote.
- `src/cli/commands/snapshot.ts`, `stats.ts`, `explain.ts`, `export.ts`, `mcp.ts`,
  `handoff.ts`, `detach.ts`, `spec.ts`, `worktree.ts`, `approval.ts`, `start.ts` — adopt
  `withCliErrors` at the 17 `try { … } catch (err) { rethrowAsCli(err); }` sites (DRY-74).
- `src/cli/rpc/run.ts`, `src/cli/headless.ts` — extract shared `resolveRunConfig` (DRY-14);
  adopt `printConfigWarnings` (DRY-57) inside it.
- `src/cli/commands/resume.ts`, `continue.ts` — extract shared `resumeSavedSession` tail
  (DRY-15) and adopt `maybeMigrateAndReport` (DRY-73).
- `src/cli/commands/spec.ts` — adopt `printConfigWarnings` (DRY-57).
- `src/cli/commands/start.ts` — adopt `maybeMigrateAndReport` (DRY-73). **Collision (not in
  the coordinator map — read this):** owned by **B08** (param fixes) then **B11** (split
  into `bootstrapSession`/`runDetachedStart`/`runJsonStart`/`runRpcStart`/
  `runInteractiveStart`). By Wave 7 the migrate calls live inside the post-split
  dispatchers — adopt there; do not recreate or revert the split.
- `src/cli/commands/doctor.ts`, `stats.ts`, `explain.ts` — adopt `writeJsonLine` (DRY-73).
- `src/cli/commands/detach.ts`, `src/cli/rpc/reader.ts` — adopt `parseJsonLine` (DRY-72).
- `src/cli/commands/ps.ts`, `src/cli/session-aliases.ts` — adopt `listSessionDirs` (DRY-72).
- `src/stores/navigation/router.ts` — share per-screen payloads between `RouteData` and
  `NavigateArgs` (DRY-23). **Collision (coordinator map):** B02 → B13. B02 added the
  `navigate` `default: return assertNever(args)` switch arm; **leave it intact** — you only
  refactor the two union type declarations.
- `src/features/workflow/components/cost/drilldown-overlay.tsx` — import the store's
  `PhaseTokens`/`PerTaskTokens` instead of re-declaring them (DRY-24); adopt `renderMeterBar`
  (DRY-69) and `formatTokensShort` is **out of scope** here (RU-12 is B04-validated — see
  Out of scope).
- `src/stores/workflow/tokens.ts` — **export** `PhaseTokens`/`PerTaskTokens` (currently
  module-private interfaces) so the overlay can import them (DRY-24).
- `src/features/summary/components/progress.tsx`, `drilldown-overlay.tsx` — adopt
  `renderMeterBar` (DRY-69).
- `src/features/workflow/components/brief-review-view.tsx` — `useBriefData` delegates to
  `loadPlanEditorData` (DRY-16).
- `src/features/workflow/components/plan-editor/loader.ts` — the canonical loader
  `useBriefData` will call (DRY-16); confirm/align its shape.
- `src/features/workflow/components/sidebar.tsx`, `src/features/summary/components/evidence.tsx`,
  `src/features/workflow/components/task-summary.tsx` — adopt one shared status→glyph map
  (PT-01).
- `src/features/workflow/components/plan-editor/task-row.tsx`,
  `src/features/workflow/plan-review-scorecard.ts`, the post-B11 split of
  `brief-review.ts` — adopt one shared `classifyReviewMetadata` (DRY-48). See the DRY-48
  step for the collision details.
- `src/components/composer/completion/completion-panel.tsx`,
  `src/components/pickers/single-column-picker.tsx`, `src/features/palette/overlay.tsx` —
  route scroll math through a new `windowSlice` helper (DRY-49).
- `src/components/pickers/picker-utils.ts` — **add** a standalone `windowSlice` export
  (DRY-49). **Collision (not in the coordinator map — read this):** owned by **B08**
  (NM-01/D5), which rewrites `computeScrollWindow`/`availableRows` so `maxVisible` caps. By
  Wave 7 that fix is in the tree. **Build on the capped version; never touch `availableRows`,
  the `visible` computation, or `computeScrollWindow` itself** — only add the new
  `windowSlice` function alongside them.
- `src/components/pickers/two-column-picker/use-column-state.ts` — import
  `clampIndex` from `utils/indexing.ts`; delete the local one (DRY-50).
- `src/features/workflow/review-parser.ts`,
  `src/features/workflow/components/plan-editor/external-editor.ts` — adopt
  `resolveEditorCommand` (DRY-47).
- `src/stores/project/detection.ts`, `src/stores/discovery/model-cache.ts` — adopt
  `cloneDetectedModel` (DRY-65).
- `src/features/workflow/conversation-rows/row-format.ts`,
  `src/features/workflow/prompt-rows.ts`, `src/components/input/text-editing.ts` — adopt
  `wrapHard` (DRY-68).
- `src/engine/orchestrator/auto-split-overflow.ts`,
  `src/features/workflow/components/plan-editor/actions.ts` — adopt `formatTaskId` (DRY-70).
  (`auto-split-overflow.ts` is under `engine/` but this row is B13's; it is a pure-function
  adoption with no react/features import — see the constraint note in the step.)
- `src/core/config/load/validate.ts`, `src/core/config/runtime/overrides.ts` —
  `keyInfoWarnings` / `parseOverrideOrThrow` extraction (DRY-71).
- `src/stores/approval-prompt/actions.ts`, `src/stores/cost-approval/actions.ts` — adopt a
  shared `createPromptChannel<Req,Res>` (DRY-78).
- `src/components/input/multiline-input.tsx` — build `FILE_DROP_PATTERN` from
  `SUPPORTED_IMAGE_EXTS` (DRY-75).
- `src/core/sessions/tree/store.ts` — private `insertEntry` shared by `appendEntry`/
  `branchFrom` (DRY-64).
- `src/features/workflow/hooks/use-workflow-runner.ts` — `isWorkflowAborted(controller, ref)`
  (RU-11).
- `src/engine/orchestrator/run/run.ts`, `src/engine/orchestrator/task/budget-check.ts`,
  `src/features/workflow/hooks/use-cost-stats.ts` — adopt `runPricingIdentity(config)`
  (RU-17). (`run.ts`/`budget-check.ts` are engine; the helper lives in `core/` so both
  engine and the UI hook may import it — see step.)
- `src/core/hooks/trust.ts`, `src/cli/commands/handoff.ts`, `src/core/schemas/codebase.ts`,
  `src/features/summary/components/review-packet.tsx` — replace `.diptych` literals with
  `DIPTYCH_DIR`/`getDiptychPath` (DRY-59b).
- CLI/UI inline `${n} X${n === 1 ? '' : 's'}` copies → `pluralize` (DRY-08b). Full site
  list in the step.

You **create** these:

- `src/cli/render-table.ts` — `renderTable(...)` (DRY-12 = KISS-05).
- `src/cli/json-line.ts` — `writeJsonLine(...)` and `parseJsonLine(...)` (DRY-72/73).
- `src/cli/session-dirs.ts` — `listSessionDirs(projectDir)` (DRY-72). *(May instead live in
  `src/cli/session-aliases.ts`; see step — pick the home that keeps imports acyclic.)*
- `src/core/providers/pricing-identity.ts` — `runPricingIdentity(config)` (RU-17).
- `src/stores/shared/prompt-channel.ts` — `createPromptChannel<Req,Res>(...)` (DRY-78).
- `src/features/workflow/review-metadata.ts` — `classifyReviewMetadata(...)` (DRY-48), only
  if a neutral home is needed after the B11 split (see step).

You do **not** create new producers for adopt-only rows — those helpers already exist (B04
/ pre-existing). If any is missing, **stop and report a producer failure**; do not recreate it.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| DRY-12 (= KISS-05) | high | `cli/commands/ps.ts:125-158`, `worktree.ts:23-119`, `approval.ts:29-60` | One `renderTable({ columns, rows, gap, headerStyle? })` that subsumes natural-width sizing, the worktree responsive shrink, and the approval bold-header + separator. |
| KISS-05 (= DRY-12) | med | `cli/commands/worktree.ts:78-96` | Array-driven columns (delivered by `renderTable`). |
| DRY-14 | high | `cli/rpc/run.ts:53-64` + `headless.ts:68-79` | `resolveRunConfig({ projectDir, opts, readiness, autoApprove? })` returning the loaded+overridden `Config`; both callers use it. |
| DRY-15 | high | `cli resume.ts:27-60` + `continue.ts:115-143` | `resumeSavedSession({ projectDir, sessionId, opts, deps })` for the load-state→assert-resumable→dispatch(headless/rpc/TUI) tail. |
| DRY-16 | high | `plan-editor/loader.ts` + `brief-review-view.tsx:62-102` | `useBriefData` reads via `loadPlanEditorData` (one tasks+brief-quality loader). |
| DRY-23 | high | `stores/navigation/router.ts:12-33` | Share the per-screen payload shapes; derive `RouteData`/`NavigateArgs` from them. |
| DRY-24 | high | `cost/drilldown-overlay.tsx:15-53` | Export `PhaseTokens`/`PerTaskTokens` from `stores/workflow/tokens.ts`; the overlay imports & derives its row types instead of re-declaring. |
| DRY-47 | med | `review-parser.ts:35` + `plan-editor/external-editor.ts:21` | Adopt `resolveEditorCommand` (producer B04). |
| DRY-48 | med | `brief-review.ts` (post-B11 split) + `worker-packet-preview.ts` (post-B09) + `plan-review-scorecard.ts` + `plan-editor/task-row.tsx` | One `classifyReviewMetadata` for the routing-reason sniffing + overlapping metadata-status predicates. (Audit also names `palette/sources`; it has no such predicates — target the real sites.) |
| DRY-49 | med | `completion-panel.tsx:34-37` + `single-column-picker.tsx:40-43` + `palette/overlay.tsx:109-110` | Route the `computeScrollOffset`+slice+show-up/down math through `computeScrollWindow`. |
| DRY-50 | med | `two-column-picker/use-column-state.ts:14` | Import `clampIndex` from `utils/indexing.ts`; delete the less-safe local copy. |
| DRY-57 | low | `cli rpc/run.ts:58` + `headless.ts:72` + `spec.ts:37` | `printConfigWarnings(warnings)` (one `for … warnStderr(\`⚠ …\`)`). |
| DRY-59b | med | `.diptych` literal — cli/core sites | Use `DIPTYCH_DIR`/`getDiptychPath` from `core/paths.ts` at `core/hooks/trust.ts:67`, `cli/commands/handoff.ts:73`, `core/schemas/codebase.ts:6`, `features/summary/components/review-packet.tsx:14`. |
| DRY-64 | low | `core/sessions/tree/store.ts:45-119` | Private `insertEntry(tree, {...})` shared by `appendEntry`/`branchFrom`. |
| DRY-65 | low | `stores/project/detection.ts` + `discovery/model-cache.ts:33` | Adopt `cloneDetectedModel` (producer B04). |
| DRY-68 | low | `row-format.ts:30` + `prompt-rows.ts:16` + `text-editing.ts:39` | Adopt `wrapHard(text, width)` (producer B04). |
| DRY-69 | low | `summary/progress.tsx:13-18` + `cost/drilldown-overlay.tsx:77-81` | Adopt `renderMeterBar(...)` (producer B04). |
| DRY-70 | low | `auto-split-overflow.ts:63` + `plan-editor/actions.ts:12` | Adopt `formatTaskId(n)` (producer B04). |
| DRY-71 | low | `config/load/validate.ts` + `runtime/overrides.ts` | Extract `keyInfoWarnings` / `parseOverrideOrThrow`. |
| DRY-72 | low | `cli {detach,rpc/reader,session-aliases,ps}.ts` | `parseJsonLine`; `listSessionDirs`. |
| DRY-73 | low | `cli {start,resume,continue,doctor,explain,stats}.ts` | `maybeMigrateAndReport`; `writeJsonLine`. |
| DRY-74 | low | `cli/commands/snapshot.ts:62` (17 sites) | `withCliErrors(fn)` wrapping the `try/catch(rethrowAsCli)` idiom. |
| DRY-75 | low | `components/input/multiline-input.tsx:9` | Build `FILE_DROP_PATTERN` from `SUPPORTED_IMAGE_EXTS` (`core/schemas/attachment.ts:3`). |
| DRY-78 | low | `stores/{approval-prompt,cost-approval}/actions.ts` | `createPromptChannel<Req,Res>(...)`. |
| DRY-08b (= RU-02, D12) | high | `utils/format.ts:1` pluralize — cli/ui inline copies | Adopt `pluralize` across the CLI/UI inline `=== 1 ? '' : 's'` copies. |
| RU-11 | med | `use-workflow-runner.ts:126,178,190` | `isWorkflowAborted(controller, abortedRef)` returning `controller.signal.aborted || abortedRef.current`. |
| RU-17 | med | `run/run.ts:33-41` + `task/budget-check.ts:27-38` + `use-cost-stats.ts:91-104` | `runPricingIdentity(config)` in `core/providers/`; adopt at all three. |
| PT-01 (= TB-08 source only) | med | `sidebar.tsx:16-23` (+ evidence/task-summary/event-format) | One semantic status→glyph map; the TB-08 *test* rewrites are B15's — do not touch them. |

## Required changes

Read each live file before editing. Steps are ordered so producers/extractions land before
their adopters. Where a fix spans many call sites, the exact grep is given — enumerate and
fix all hits.

### 1. `renderTable` — new `src/cli/render-table.ts` (DRY-12 = KISS-05)

Create a single column-table renderer that subsumes all three current hand-rolled tables.
It must handle: (a) per-column natural width = `max(min, header.length, ...cell.lengths)`;
(b) optional **responsive shrink** of flagged columns when total width exceeds
`process.stdout.columns ?? 80` (worktree shrinks `path`, then `branch`, then `name`, each to
its `min`, and truncates over-long cells with `slice`); (c) optional bold headers + a dim
`-`.repeat separator row (approval). Suggested shape:

```ts
export interface TableColumn<R> {
  header: string;
  min: number;
  value: (row: R) => string;
  shrink?: boolean;     // eligible for responsive narrowing (worktree path/branch/name)
  truncate?: boolean;   // slice over-long cells to the column width
}
export interface RenderTableOptions<R> {
  columns: TableColumn<R>[];
  rows: R[];
  gap?: number;             // default 2
  boldHeader?: boolean;     // approval uses ansis.bold
  separator?: boolean;      // approval prints a dim '-'.repeat row under the header
}
export function renderTable<R>(opts: RenderTableOptions<R>): string[];  // lines, caller console.log's
```

Keep the responsive algorithm behaviorally equal to `worktree.ts:78-96` (shrink `path` by
the overflow, then `branch`, then `name`, each `Math.max(min, …)`). `ansis` is already a dep
(used in approval/stats) — import it here for `boldHeader`/`separator`.

Then convert the three call sites:
- `cli/commands/ps.ts:125-158` — columns `#`(alias), `SESSION ID`, `STATUS`, `PID`, `MODE`,
  `ELAPSED`, `FEATURE` with the same mins (2/10/7/5/8/9). The trailing `FEATURE` column is
  unpadded today; model it as the last column with `truncate:false` and no padding (the
  renderer should not pad the final column). Keep `formatElapsed`, alias `'-'` and
  `pid ?? '-'` logic at the `value` callbacks.
- `cli/commands/worktree.ts:23-119` — columns NAME/PATH/BRANCH/STATUS/SESSION/PHASE/UPDATED
  with mins 12/18/18/10/12/10/12; `PATH`/`BRANCH`/`NAME` get `shrink:true, truncate:true`.
  Delete `renderList`, `statusCell`, `valueOrUnknown` is reduced to inline `?? 'unknown'`
  callbacks. Keep the "No diptych-managed worktrees found." early return.
- `cli/commands/approval.ts:29-60` — columns pattern/class/scope/sessionId/grantedAt with
  mins 7/5/7/9/(grantedAt natural); `boldHeader:true, separator:true`. The `clear`
  subcommand does not use the table.

### 2. `withCliErrors` — add to `src/cli/errors.ts` (DRY-74)

`cli/errors.ts` already exports `class CliError extends Error`, `cliError`, `isCliError`,
`rethrowAsCli` (from B05). Add:

```ts
export async function withCliErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowAsCli(err);
  }
}
```

`rethrowAsCli` returns `never`, so the `catch` satisfies the return type. The 17 sites are
**not uniform** — classify each before converting (grep
`rg -n "rethrowAsCli\(err\)" src/cli`):
- **Whole-action wrap** (the entire `.action` body is in one `try`): `stats.ts:69-71`,
  `approval.ts` list (20-63) and clear (72-90), `mcp.ts`, `export.ts`, `handoff.ts`,
  `spec.ts`, `explain.ts`, `start.ts`. Convert `try { … } catch { rethrowAsCli(err); }` →
  `await withCliErrors(async () => { … })`.
- **Single-call wrap with logic after the try** (result is used *outside* the `try`):
  `snapshot.ts` `restore` (106-115 → `result` used at 117+) and `diff` (155-167 →
  `manifest`/`result` used after), `detach.ts` (85-89 → `console.log` after). Convert to
  `const result = await withCliErrors(() => restoreSnapshot({ … }));` so the post-try logic
  and the `throw cliError(...)` for conflicts/diffs are preserved verbatim.
- **Per-call wraps inside one action**: `snapshot.ts` `create` (25-64) and `list` (76-92)
  wrap one async call each — same single-call treatment.
Do not move any logic into or out of the wrapped callback beyond what was already inside the
`try`. `worktree.ts` `remove` (182-192) also uses the `try/catch(rethrowAsCli)` idiom around
`deps.removeWorktree(...)` — convert it too (it is one of the 17).

### 3. `resolveRunConfig` — shared by `cli/rpc/run.ts` + `cli/headless.ts` (DRY-14, DRY-57)

Both `run.ts:53-64` (`loadAndApplyConfig`) and `headless.ts:68-79` do: pick
`readiness.config` else `loadConfig(projectDir)`, print warnings, `applyCLIOverrides(loaded,
buildCLIOverrides(opts))`, then `if (!config) throw cliError('Failed to load config')`.
headless additionally forces `autoApprove: opts.auto ?? true`. Extract into a shared home —
put `resolveRunConfig` in `src/cli/build-overrides.ts` (already imported by both) or a new
`src/cli/run-config.ts`; pick whichever keeps imports acyclic (`build-overrides.ts` already
imports nothing from run/headless, so it is safe):

```ts
export function resolveRunConfig(args: {
  projectDir: string;
  opts: WorkflowOpts;
  readiness?: CollectedReadiness | undefined;
  autoApprove?: boolean | undefined;   // headless passes opts.auto ?? true
}): Config { … }
```

Inside it: load (readiness-or-loadConfig), call `printConfigWarnings(warnings)` (step 3a),
`applyCLIOverrides` with `buildCLIOverrides(opts)` plus the optional `{ autoApprove }`, and
the `if (!config) throw cliError('Failed to load config')` guard **moved verbatim** (its
removal is AS-02 → B16, out of scope here). Update both callers:
- `run.ts` `loadAndApplyConfig` → delete; `runRpc` calls `resolveRunConfig({ projectDir,
  opts, readiness })`.
- `headless.ts` inline loader → `resolveRunConfig({ projectDir, opts, readiness, autoApprove:
  opts.auto ?? true })`. Keep the subsequent `workflow.taskReview` guard in `headless.ts`.

**3a. `printConfigWarnings` (DRY-57).** Add `export function printConfigWarnings(warnings:
readonly string[]): void { for (const w of warnings) warnStderr(\`⚠ ${w}\`); }` next to
`resolveRunConfig` (or in `cli/setup.ts` — wherever `warnStderr` is already imported). Adopt
at `cli/commands/spec.ts:37` (`for (const w of warnings) warnStderr(\`⚠ ${w}\`)`) too. The
run/headless loops are absorbed by `resolveRunConfig`.

### 4. `resumeSavedSession` — shared by `resume.ts` + `continue.ts` (DRY-15)

`resume.ts:35-60` and `continue.ts:118-143` share: `loadState` → null-guard with a
session-specific `cliError` → `assertResumableState` → `if (opts.json) runHeadless(...)` →
`if (opts.rpc) runRpc(...)` → else log `Resuming: …` + `setupWorkflow` + `initStores` +
`routerStore.init({ screen: 'workflow', … resumeState, sessionId })` + `renderApp`. Extract a
shared tail. `continue.ts` already threads a `ContinueDeps` (initStores/renderApp/runHeadless/
runRpc/setupWorkflow); make the helper accept the same deps so `continue` keeps its testable
seams and `resume` passes the real defaults. Suggested home: `src/cli/commands/continue.ts`
(export it) or a new `src/cli/resume-session.ts`:

```ts
export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  opts: WorkflowOpts;
  deps?: Pick<ContinueDeps, 'initStores' | 'renderApp' | 'runHeadless' | 'runRpc' | 'setupWorkflow'>;
}): Promise<void> { … }
```

Inside: `loadState`, the no-state `cliError` (keep both call sites' message text — they
differ slightly: resume says "has no state.json — cannot resume.", continue says "has no
saved state and is not running — cannot continue." — pass the message in or keep each
caller's guard *before* calling the shared tail so the messages stay), `assertResumableState`,
then the json/rpc/TUI dispatch. The cleanest split: keep each command's pre-checks (active
pointer, running-attach for continue, no-state message) in the command, and let
`resumeSavedSession` own only the **identical** `assertResumableState`→dispatch tail. Update
both commands to call it. Do not change `continue`'s running-session attach branch
(95-109) — that is unique to continue.

### 5. `maybeMigrateAndReport` + `writeJsonLine` + `parseJsonLine` + `listSessionDirs` (DRY-72, DRY-73)

**5a. `maybeMigrateAndReport` (DRY-73).** The pattern `const migration = await
maybeMigrate(projectDir); if (!opts.json && !opts.rpc) printMigrationResult(migration);`
appears at `resume.ts:27-28`, `continue.ts:115-116`, and (post-B11) inside the `start.ts`
dispatchers. Add `export async function maybeMigrateAndReport(projectDir: string, opts: {
json?: boolean; rpc?: boolean }): Promise<void>` to `src/cli/commands/migrate.ts` (it already
exports `printMigrationResult` and imports `maybeMigrate` is available from
`core/migration/executor.js`). Adopt at resume/continue. In `start.ts`, the detached path
(`start.ts:142`, `printMigrationResult(await maybeMigrate(projectDir))`) is **unconditional**
(no json/rpc guard) — leave that one as-is or add an `always`-style call; only convert the
guarded `start.ts` site (the json/rpc-gated one, post-B11 in `runJsonStart`/`runRpcStart`
context). Build on B11's post-split structure; grep `rg -n "maybeMigrate" src/cli/commands/start.ts`
in the live (post-B11) file to find the exact sites.

**5b. `writeJsonLine` (DRY-73) + `parseJsonLine` (DRY-72).** Create `src/cli/json-line.ts`:

```ts
export function writeJsonLine(value: unknown, out: NodeJS.WritableStream = process.stdout): void {
  out.write(JSON.stringify(value) + '\n');
}
export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}
```

Adopt `writeJsonLine` at `doctor.ts:23`, `stats.ts:43`, `explain.ts:28` (note explain uses
`JSON.stringify(x, null, 2)` — keep its pretty-print by **not** converting that one unless
you add an optional `pretty` flag; simplest is to leave explain's pretty line as-is and only
convert the compact `doctor`/`stats` lines, then mark explain's site covered by the same
helper if you add the flag — decide and be consistent). Adopt `parseJsonLine` at
`detach.ts:31-36` (the `try { JSON.parse } catch { return }` returns silently — `parseJsonLine`
returning `undefined` matches: `const parsed = parseJsonLine(line); if (parsed === undefined)
return;`) and `reader.ts:16-22` (this one calls `onError('Invalid JSON: …')` on failure —
`parseJsonLine` swallows, so preserve the error path: `const parsed = parseJsonLine(trimmed);
if (parsed === undefined) { onError(\`Invalid JSON: ${trimmed}\`); return; }` — but note
`reader.ts` also rejects empty lines via its own guard; keep `parseJsonLine`'s empty→undefined
behavior consistent with that). Do not weaken either site's downstream Zod validation.

**5c. `listSessionDirs` (DRY-72).** `ps.ts:110` and `session-aliases.ts:32` both do
`existsSync(root)` then `readdirSync(root, { withFileTypes: true }).filter(e =>
e.isDirectory())`. Add `export function listSessionDirs(projectDir: string): string[]`
returning the directory **names** (`[]` when root missing) to `src/cli/session-aliases.ts`
(it already imports `sessionsRoot`/`readdirSync`/`existsSync`). Adopt at both. `ps.ts` maps
names→`buildRow(join(root, name), name, …)`; have it call `listSessionDirs` then `join` with
`sessionsRoot(projectDir)`.

### 6. Router payload sharing — `stores/navigation/router.ts` (DRY-23)

`RouteData` (lines 12-16) and `NavigateArgs` (29-33) carry the same per-screen fields keyed
by `screen` vs `to`. Define one set of payload shapes and derive both. Example:

```ts
type WorkflowPayload = { feature: string; plannerContext?: string | undefined; resumeState?: WorkflowState | undefined; sessionId?: string | undefined; worktreeName?: string | undefined; attach?: WorkflowAttach | undefined; readiness?: ReadinessReport | undefined };
type SummaryPayload = { summary: Summary; sessionId?: string | undefined };
type SetupPayload  = { onComplete?: 'home' | 'workflow' | undefined; feature?: string | undefined; plannerContext?: string | undefined };

export type RouteData =
  | { screen: 'home' }
  | ({ screen: 'workflow' } & WorkflowPayload)
  | ({ screen: 'summary' } & SummaryPayload)
  | ({ screen: 'setup' } & SetupPayload);

export type NavigateArgs =
  | { to: 'home' }
  | ({ to: 'workflow' } & WorkflowPayload)
  | ({ to: 'summary' } & SummaryPayload)
  | ({ to: 'setup' } & SetupPayload);
```

The `navigate` switch body and B02's `default: assertNever(args)` stay unchanged. Verify the
`store.set({ screen: 'workflow', … })` object literals still typecheck against the derived
union (they will — same fields).

### 7. Cost drilldown store types + `renderMeterBar` (DRY-24, DRY-69)

**7a. Export store types (DRY-24).** In `stores/workflow/tokens.ts`, change `interface
PhaseTokens` (9-23) and `interface PerTaskTokens` (25-29) to `export interface`. In
`cost/drilldown-overlay.tsx`, delete the locally re-declared `PhaseRow` (15-30) /`TaskRow`
(32-36) field duplications: import `PhaseTokens`/`PerTaskTokens` and derive the row types
(`PhaseRow = PhaseTokens & { phase: Phase }`, `TaskRow = { taskId: string } & Pick<PerTaskTokens,
'title'> & { totalTokens: number }`). Keep `buildPhaseRows`/`buildTaskRows` behavior; their
inline `Record<string, {…}>` param at `buildPhaseRows` (39-53) should reference
`Partial<Record<Phase, PhaseTokens>>` / `PhaseTokens` to match the store, not a re-typed
duplicate.

**7b. `renderMeterBar` (DRY-69).** `renderBar` in `drilldown-overlay.tsx:77-81` and
`progressBar` in `summary/progress.tsx:13-18` both build `█`-filled / `░`-empty bars. The B04
producer is `renderMeterBar` in `src/features/cost/meter-bar.ts`. Confirm its signature, then
replace both. Note the **semantic difference**: `renderBar` returns `''` when `max === 0`;
`progressBar` returns a full `'░'.repeat(width)` when `total === 0`. If `renderMeterBar`
takes only `(value, max, width)`, preserve each site's empty-case at the call site (e.g.
`progress.tsx` keeps `total === 0 ? '░'.repeat(width) : renderMeterBar(...)`), or use the
producer's documented empty behavior — do not change either bar's rendered output. Verify
against the live `meter-bar.ts` before wiring.

**7c. (courtesy) `formatTokensShort` (RU-12 — owned by B04, not a B13 finding).** While in
`drilldown-overlay.tsx` you will see `formatCacheCreateTokens` (≈85) and the other inline
`(n / 1000).toFixed(1)k` token-shortening copies. RU-12's adoption is validated under **B04**,
not here, so it is **not** in your Findings table and not a B13 acceptance gate. But because
you are already editing this file (7a/7b) and leaving an inline copy a B13 anti-slop pass
could flag, you **may** fold the one-line adoption (`formatTokensShort` from
`core/formatting.ts`) at the token-shortening sites here. Confirm the producer exists; do not
recreate it; do not list it as a B13 finding.

### 8. `useBriefData` → `loadPlanEditorData` (DRY-16)

`brief-review-view.tsx`'s `useBriefData` (62-102) re-implements the tasks + `brief-quality.json`
load + `parseTasks` + `refreshPlanReviewMetadata` + `isBriefQualityReport` parse that
`plan-editor/loader.ts`'s `loadPlanEditorData` (30-45) already does. Refactor `useBriefData`
to call `loadPlanEditorData({ filePath, sessionDirPath: dirname(filePath), signal })` and map
its `{ tasks, quality }` into the component's `BriefData` (`{ tasks, quality, loadError }`),
keeping the `loadError` catch and abort handling. `loadPlanEditorData` already calls
`planEditorStore.initEditor` + `setReviewMetadata`; confirm `useBriefData` no longer needs to
call `setReviewMetadata` itself (avoid double-calling). If `loadPlanEditorData`'s
`initEditor(tasks)` is unwanted in the read-only view, add an option to `LoadPlanEditorDataOptions`
to skip it; otherwise keep behavior identical and remove the dup. **Note:** `loader.ts`
imports `refreshPlanReviewMetadata` from `../brief-review.js` — after B11 splits
`brief-review.ts`, that import path may move to the pure-formatter module; update the import
to wherever B11 placed `refreshPlanReviewMetadata`.

### 9. Status→glyph single source (PT-01)

Three contradictory maps exist:
- `sidebar.tsx:16-23` — `done:'✓'`, `failed:'✗'`, `escalated:'⚠'`, `in_progress:'◉'`,
  `pending:'○'`, `skipped:'○'`, keyed by `WorkflowTask['status']` (`TaskStatus`).
- `evidence.tsx:13-19` (`statusGlyph`) — `done:'✔'`, `escalated/escalated-flag:'↑'`,
  `failed:'✗'`, `skipped:'–'`, else `'·'`, keyed by `EvidenceTask` (status + `escalated`).
- `task-summary.tsx:29-33` — `skipped:'⊘'` (keyed by `method`).

Create one semantic map keyed by `TaskStatus` in a neutral UI home — recommend
`src/features/workflow/status-glyph.ts` exporting `STATUS_GLYPH: Record<TaskStatus, string>`
and a small accessor. Pick the canonical glyph per status (resolve the contradictions: e.g.
`done:'✓'`, `skipped:'○'`, `escalated:'⚠'`, `failed:'✗'`, `in_progress:'◉'`, `pending:'○'`
— match `sidebar.tsx` as the most complete). Adopt in `sidebar.tsx` (replace `statusIcon`).
For `evidence.tsx` and `task-summary.tsx`, map their inputs onto `TaskStatus` first
(`evidence`: derive status incl. the `escalated` boolean → `escalated`; `task-summary`: its
`method` of `'failed'`/`'skipped'` maps to those statuses) then read `STATUS_GLYPH`. **Do not
change `event-format.ts:61`** — that is a binary stage-complete `'✓'`/`'○'` (not a TaskStatus
map); leave it. **PT-01 is cross-listed with TB-08 (B15): do not touch any test file** — the
glyph-assertion test rewrites belong to B15.

### 10. `classifyReviewMetadata` single source (DRY-48)

The same review-metadata predicates are duplicated across:
- `plan-review-scorecard.ts`: `hasNoCapableWorker` (80-85), `STALE_ESTIMATE_STATUSES`
  (59-62), `hasRoutingPendingCondition` (87-98), `hasStaleConflictCondition` (119-123).
- `worker-packet-preview.ts`: `hasPendingRoutingMetadata` (181-195) ≈ `hasRoutingPendingCondition`;
  `requiresRefresh` (197-202) ≈ `hasStaleConflictCondition`; inline `noCapableWorker`
  (187-190) ≈ `hasNoCapableWorker`.
- `brief-review.ts` (post-B11 split): `hasBlockingReviewState` (30-39), `hasNoCapableWorker`
  logic.
- `plan-editor/task-row.tsx`: its own `hasError`/`hasConflict`/`hasOverflow`/`hasStale` flags.

**These predicates are inherently features-side.** Every one consumes
`PlanTaskReviewMetadata` — a store type (`stores/workflow/plan-editor.ts`) that `engine/`
cannot import. So consolidation lives in `features/`, all four sites are features-side, and
the post-B09 routing-preview *facade* (which is under `engine/`) does **not** consume these
helpers — there is no engine→features risk and no second source. **Coordination:** by Wave 7,
**B11** has split `brief-review.ts` into a pure formatter + `plan-review-metadata.ts`
(SRP-03), and **B09** has moved `worker-packet-preview.ts`'s engine routing logic into the
facade (SRP-04/AR-05) — but the metadata-status predicates (`hasPendingRoutingMetadata`,
`requiresRefresh`, the no-capable-worker sniffing) stay features-side because of the type
dependency. Read the **live** post-B09/B11 files to confirm where each predicate landed, then
extract them into one module — `src/features/workflow/review-metadata.ts` exporting:

```ts
export const STALE_ESTIMATE_STATUSES: ReadonlySet<PlanTaskReviewMetadata['estimateStatus']>;
export function hasNoCapableWorker(m: PlanTaskReviewMetadata): boolean;
export function isRoutingPending(task: Task, m: PlanTaskReviewMetadata | undefined): boolean;
export function hasStaleOrConflict(m: PlanTaskReviewMetadata | undefined): boolean;
export function classifyReviewMetadata(task: Task, m: PlanTaskReviewMetadata | undefined, issues: BriefQualityIssue[]): { /* the buckets/flags both callers need */ };
```

Have the four features-side sites — `plan-review-scorecard.ts`, the post-B11 `brief-review`
formatter, the features-side `worker-packet-preview` predicate residue, and `task-row.tsx` —
import from this module instead of each holding their own copies. Keep the routing-reason
`.toLowerCase().includes('no capable'|'overflows'|'function-level context'|'current code
truncated')` sniffing in **one** place (the helper) — the audit's core complaint. Do **not**
alter the bucket semantics of `buildPlanReviewScorecard`; only deduplicate the predicates it
composes. The post-B09 `routing-preview` facade is under `engine/` and consumes structured
`RoutingDecision`s, not `PlanTaskReviewMetadata`, so it does **not** import this module — no
engine→features edge is created. If the live post-B11 file layout surprises you (a predicate
landed somewhere unexpected), flag it in your summary rather than forcing the import.
(Audit also lists `palette/sources` for this row; it contains no such predicates — do not
invent work there.)

### 11. Scroll-window adoption (DRY-49) + `clampIndex` (DRY-50)

**11a. DRY-49.** Three sites re-implement the same window math (`computeScrollOffset` + slice
+ show-up/down). They all receive an **already-resolved window size** (a `maxVisible`/`MAX_VISIBLE`
prop), so they do not need `computeScrollWindow` (which resolves the window from rows/chrome —
that is B08's capped function; **leave it untouched**). Add **one new standalone export** to
`picker-utils.ts` that takes a pre-resolved window size and reuses the existing
`computeScrollOffset`:

```ts
export function windowSlice<T>(items: T[], selectedIndex: number, windowSize: number) {
  const scrollOffset = computeScrollOffset(selectedIndex, windowSize, items.length);
  return {
    scrollOffset,
    visibleSlice: items.slice(scrollOffset, scrollOffset + windowSize),
    showScrollUp: scrollOffset > 0,
    showScrollDown: scrollOffset + windowSize < items.length,
  };
}
```

Do **not** modify `computeScrollWindow`, `availableRows`, or the `visible` computation —
those are B08's (D5). Adopt `windowSlice` at the three sites:
- `completion-panel.tsx:34-37` — `const { scrollOffset, visibleSlice, showScrollUp,
  showScrollDown } = windowSlice(items, selectedIndex, maxVisible);`
- `single-column-picker.tsx:40-43` — same, with `visibleRows` as the window size; the local
  var is `slice` there, so destructure `visibleSlice` and rename in use (or alias).
- `palette/overlay.tsx:109-110` — has no up/down indicators; use only
  `windowSlice(results, cursor, MAX_VISIBLE).visibleSlice` / `.scrollOffset` (the `globalIndex
  = scrollOffset + i` math at 128 must read the same `scrollOffset`).
Preserve each site's rendered output exactly (indicator placement, `globalIndex` math). Whether
`computeScrollWindow` internally also calls `windowSlice` is immaterial to this finding — do
not refactor it.

**11b. DRY-50.** `use-column-state.ts:14` declares a local `clampIndex = (index, length) =>
Math.min(index, Math.max(0, length - 1))` — unsafe at `length === 0` (returns `min(index,0)`
which can be `0` only if index ≤ 0; for index>0 it returns 0 — but the util is clearer/safer).
The util `utils/indexing.ts:1` `clampIndex(current, length)` returns `0` when `length <= 0`.
Delete the local one; `import { clampIndex } from '../../../utils/indexing.js'` and use it at
line 25 (`clampIndex(index, items.length)`). Verify behavior at `length === 0`: util returns
`0`, `items[0]` is `undefined` → `currentItem` undefined, same as before.

### 12. Adopt B04 producers — `resolveEditorCommand`, `cloneDetectedModel`, `wrapHard`, `formatTaskId`

For each, confirm the producer exists (B04, Wave 2). If absent → **stop, report producer
failure**.

**12a. `resolveEditorCommand` (DRY-47).** `review-parser.ts:35` (`const editor =
process.env.EDITOR || 'vi'`) and `plan-editor/external-editor.ts:21` (`const editor =
process.env.EDITOR ?? 'vi'`) both pick the editor. Note the slight difference (`||` vs `??`)
— `resolveEditorCommand` (B04) decides the canonical semantics; adopt it at both, and verify
the resulting command still spawns correctly (`spawn`/`spawnSync` with `[filePath]`).

**12b. `cloneDetectedModel` (DRY-65).** `discovery/model-cache.ts:33` `cloneModels` maps over
`DetectedModel[]` cloning each; `stores/project/detection.ts` clones similarly. Adopt the B04
`cloneDetectedModel(model)`: `cloneModels(models)` becomes `models.map(cloneDetectedModel)`,
and the detection-store clone uses it. Read both files to find the exact clone expressions.

**12c. `wrapHard` (DRY-68).** The idiom `wrapAnsi(text, columns, { trim: false, hard: true
}).split('\n')` appears at `row-format.ts:30` (`wrapText`) and `text-editing.ts:39-40`;
`prompt-rows.ts:16` uses `wrapAnsi(text, textWidth, { trim:false, hard:true }).split('\n')`
inside a `.length` (count only). Adopt `wrapHard(text, width)` from `utils/wrap.ts`:
`wrapText` returns `wrapHard(text, Math.max(MIN_ROW_WIDTH, width))`; `prompt-rows.ts:16`
becomes `wrapHard(text, textWidth).length`; `text-editing.ts:39-40` becomes
`wrapHard(lineWithCursor, columns)` (then `.split` is already done inside `wrapHard` — adjust
to consume the returned `string[]`). Confirm `wrapHard`'s exact return type (array vs string)
from the live `utils/wrap.ts` and adapt each site.

**12d. `formatTaskId` (DRY-70).** `auto-split-overflow.ts:63` `taskId(\`T${String(index).padStart(3,
'0')}\`)` and `plan-editor/actions.ts:12` `taskId(\`T${String(i + 1).padStart(3, '0')}\`)`.
Adopt `formatTaskId(n)` from `core/schemas/task.ts` (returns the `"T###"` string): become
`taskId(formatTaskId(index))` and `taskId(formatTaskId(i + 1))`. **Engine-import note:**
`auto-split-overflow.ts` is under `engine/`; `core/schemas/task.ts` is core, so this import is
allowed (engine→core is fine; the prohibition is engine→react/features). No violation.

### 13. `runPricingIdentity` (RU-17)

Create `src/core/providers/pricing-identity.ts`:

```ts
import type { Config } from '../schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';
import { resolveAutoModel } from './model-selection.js';

export interface PricingIdentity {
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
}

export function runPricingIdentity(config: Config): PricingIdentity {
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = resolveAutoModel(config.implementer.model, getRunnerDisplayName(config.implementer));
  return {
    plannerTool: getRunnerDisplayName(config.planner),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(plannerModel !== undefined && { plannerModel }),
    ...(implementerModel !== undefined && { implementerModel }),
  };
}
```

(Match the exact `resolveAutoModel`/`getRunnerModelName` usage in `run/run.ts:33-34` — note
`run.ts` uses `resolveAutoModel` for the *implementer* model and raw `getRunnerModelName` for
the *planner*; replicate that asymmetry so behavior is unchanged.) This lives in `core/` so
both engine (`run/run.ts`, `task/budget-check.ts`) and the UI hook (`use-cost-stats.ts`) may
import it without breaking engine-no-react. Adopt:
- `run/run.ts:33-41` — replace the four derivations feeding `summaryBase` with
  `const ident = runPricingIdentity(config);` and spread/assign its fields.
- `use-cost-stats.ts:91-104` — replace the four derivations with `runPricingIdentity(config)`.
- `task/budget-check.ts:27-38` — this site uses `state.plannerModel ?? getRunnerModelName(...)`
  (state-fallback). Use `runPricingIdentity(config)` as the **fallback default**:
  `const ident = runPricingIdentity(config); plannerTool: state.plannerTool ?? ident.plannerTool`,
  etc. Preserve the `state.* ??` precedence exactly.

### 14. `.diptych` → `DIPTYCH_DIR`/`getDiptychPath` (DRY-59b)

`DIPTYCH_DIR` and `getDiptychPath(projectDir, ...parts)` already exist in `core/paths.ts`.
Replace the cli/core literal sites:
- `core/hooks/trust.ts:67` `join(projectDir, '.diptych', TRUST_FILE)` → `getDiptychPath(projectDir,
  TRUST_FILE)`.
- `cli/commands/handoff.ts:73` `join(projectDir, '.diptych', 'handoffs', target)` →
  `getDiptychPath(projectDir, 'handoffs', target)`.
- `core/schemas/codebase.ts:6` `cacheDir: z.string().default('.diptych')` → `.default(DIPTYCH_DIR)`.
- `features/summary/components/review-packet.tsx:14` `\`.diptych/sessions/${sessionId}/${path}\``
  — this is a *display* path string, not a filesystem `join`. Prefer `\`${DIPTYCH_DIR}/sessions/${sessionId}/${path}\``
  to kill the literal (do not switch to `join`/`getDiptychPath` — it is a label, not a path
  the code reads). Confirm it remains a forward-slash display string.
Engine sites (`engine/handoff/*`, `engine/snapshots/store.ts`, `engine/hooks/discover.ts`,
`engine/codebase/*`, `engine/orchestrator/explain/artifacts.ts`) are **DRY-59a → B12**; do not
touch them.

### 15. `createPromptChannel<Req, Res>` (DRY-78)

`approval-prompt/actions.ts` and `cost-approval/actions.ts` share the open(supersede)/close
promise pattern over a store of shape `{ status: 'idle' } | { status: 'pending', resolve, …payload }`.
Create `src/stores/shared/prompt-channel.ts`:

```ts
export function createPromptChannel<Req, Res>(deps: {
  get: () => { status: 'idle' } | ({ status: 'pending'; resolve: (res: Res) => void } & Record<string, unknown>);
  setPending: (req: Req, resolve: (res: Res) => void) => void;   // store-specific: writes {status:'pending', <reqField>, resolve}
  setIdle: () => void;
  supersededValue: Res;        // approval: {decision:'deny',reason:'superseded'}; cost: false
  cancelledValue: Res;         // approval: {decision:'deny',reason:'user_cancelled'}; cost: false
}): {
  open: (req: Req) => Promise<Res>;
  close: (res?: Res) => void;
};
```

`open(req)` returns a promise; if current is pending, supersede (write new pending, resolve
the previous with `supersededValue`) else set pending. `close(res?)` sets idle and resolves
the prior pending with `res ?? cancelledValue`. Note **cost-approval's `close(approved:
boolean)` is non-optional and has no "cancelled" default** — its `closeCostApprovalPrompt`
always passes a boolean. Keep each module's public function signatures
(`openApprovalPrompt`/`closeApprovalPrompt`, `openCostApprovalPrompt`/`closeCostApprovalPrompt`)
exactly as today; implement them via `createPromptChannel`. The store-specific
`setPending`/payload-field wiring stays in each actions file. Verify the
`tiered-approval`/cost-approval behavior tests still pass (supersede resolves previous with
deny/false; close with no arg → user_cancelled for approval).

### 16. `FILE_DROP_PATTERN` from `SUPPORTED_IMAGE_EXTS` (DRY-75)

`multiline-input.tsx:9` hard-codes `/^\S+\.(jpe?g|png|gif|webp|bmp)$/i`. `core/schemas/attachment.ts:3`
exports `SUPPORTED_IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','bmp']`. Build the regex from
the const so they cannot drift:

```ts
import { SUPPORTED_IMAGE_EXTS } from '../../core/schemas/attachment.js';
const FILE_DROP_PATTERN = new RegExp(`^\\S+\\.(${SUPPORTED_IMAGE_EXTS.join('|')})$`, 'i');
```

This yields `(jpg|jpeg|png|gif|webp|bmp)` — equivalent to `(jpe?g|…)` for matching. Confirm
`multiline-input.tsx` is at `src/components/input/multiline-input.tsx` (the audit's path was
`multiline-input.tsx:9` without the dir). If `escapeRegExp` (B04, `utils/regexp.ts`) is
desired for safety, the extensions are static literals so a raw join is acceptable; do not
over-engineer.

### 17. `insertEntry` in `core/sessions/tree/store.ts` (DRY-64)

`appendEntry` (45-75) and `branchFrom` (85-119) share: compute `id = nextEntryId(meta.entryCount)`,
build the envelope, clone `entries`+`children` maps, push the child under the parent, build
new `meta`. They differ only in `parentId` (`meta.leafId` vs `opts.fromId`), the
`branchCount` increment, and `branchFrom`'s `entries.has(fromId)` precheck. Extract:

```ts
function insertEntry(tree: SessionTree, opts: {
  parentId: EntryId; type: string; payload: unknown; timestamp: number;
  display?: boolean; incrementBranch: boolean;
}): { tree: SessionTree; entry: TreeEntryEnvelope } { … }
```

`appendEntry` calls it with `parentId: tree.meta.leafId, incrementBranch: false`; `branchFrom`
keeps its `if (!tree.entries.has(opts.fromId)) throw …` guard, then calls `insertEntry` with
`parentId: opts.fromId, incrementBranch: true`. **Do NOT touch** `childrenOf` (137-139) or
`isOnActivePath` (142-145) — they are dead code owned by B14 (DC-13).

### 18. `isWorkflowAborted` (RU-11)

In `use-workflow-runner.ts`, the predicate `controller.signal.aborted || abortedRef.current`
(and its negation) recurs at the `while` (126), the post-run guard (178), and the catch guard
(190, combined with `!lifecycleStore.get().cancelled`). Add a module-scope helper
`function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
return controller.signal.aborted || ref.current; }` and use it:
- line 126: `while (!isWorkflowAborted(controller, abortedRef)) {`
- line 178: `if (isWorkflowAborted(controller, abortedRef)) return;`
- line 190: `if (!isWorkflowAborted(controller, abortedRef) && !lifecycleStore.get().cancelled) {`
Keep the `lifecycleStore.get().cancelled` term as a separate conjunct at 190.

### 19. `keyInfoWarnings` / `parseOverrideOrThrow` (DRY-71)

This is **two independent intra-file dedupes** (one per file), not one cross-file helper:

**19a. `keyInfoWarnings` in `core/config/load/validate.ts`.** `securityWarnings` (141-167)
runs the **identical** block twice — once for the planner/implementer roles (144-151) and
once per implementer profile (153-162):

```ts
if (info.inConfig && info.envVar && info.envRecommended) {
  warnings.push(`API key found in ${role} config. For better security, set ${info.envVar} environment variable and remove apiKey from config.`);
}
if (info.key && info.provider) {
  warnings.push(...keyFormatWarnings(info.provider, info.key));
}
```

Extract a private `function keyInfoWarnings(role: string, info: KeyInfo): string[]` returning
those warnings, and call it in both loops (`warnings.push(...keyInfoWarnings(role, info))`).
Behavior of `securityWarnings` must be byte-identical. (`profileCredentialWarnings` at 169-185
is a different concern — leave it.)

**19b. `parseOverrideOrThrow` in `core/config/runtime/overrides.ts`.** `applyCLIOverrides`
repeats `const parsed = XSchema.safeParse(value); if (!parsed.success) throw
configError.invalidOverride(label, value, \`Must be one of: ${VALUES.join(', ')}\`); …use
parsed.data` at `--approve` (101-110, `ApproveLevelSchema`/`APPROVE_LEVELS`) and
`--planner-effort` (144-153, `EffortLevelSchema`/`EFFORT_LEVELS`). Extract:

```ts
function parseOverrideOrThrow<T>(schema: ZodType<T>, value: unknown, label: string, allowed: readonly string[]): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw configError.invalidOverride(label, value, `Must be one of: ${allowed.join(', ')}`);
  }
  return parsed.data;
}
```

Adopt at both Zod-schema sites. The `--mode` (123-133, uses `normalizeLegacyMode`, not a
schema) and `budget` (134-143, numeric guard) branches do **not** fit this shape — leave them
as-is. Keep `applyCLIOverrides` behavior identical. This is a `low`; if reading the live files
shows the duplication already gone (an earlier brief touched these), mark PASS and move on.

### 20. `pluralize` adoption (DRY-08b, D12)

`pluralize(n, singular, plural?)` exists in `utils/format.ts`. Replace the inline
`${n} word${n === 1 ? '' : 's'}` copies. Grep to enumerate:
`rg -n "=== 1 \? '' : 's'" src/cli src/features src/components src/stores` (exclude tests).
Known CLI/UI sites (convert each `\`${n} word${n === 1 ? '' : 's'}\`` →
`\`${n} ${pluralize(n, 'word')}\``):
- `cli/commands/status.ts:30,47`, `cli/commands/stats.ts:53,64` (`session`).
- `features/workflow/recovery-prompt.ts:129` (`attempt`).
- `features/workflow/worker-packet-preview.ts:108,115` (`line`/`char`) — **only if** still in
  this file post-B09; if B09 moved this code to the facade, adopt there or mark for the
  facade's home.
- `features/workflow/components/brief-review.ts:53,60` (`check`/`task`) — adopt in the
  **post-B11** split formatter file.
- `features/workflow/components/conversation-flow/flow.tsx:25,26,110` (`line`/`event`).
- `features/workflow/conversation-rows/event-rows.ts:84,86,88,130,132,136` (`warning`/`error`/
  `message`/`image`).
- `features/summary/screen.tsx:104,107` (`error`/`warning`).
- `features/summary/components/review-packet.tsx:44,46` (`error`/`warning`).
- `features/workflow/components/readiness-panel.tsx:44` (`advisory note`).
Import `pluralize` from `../../utils/format.js` (adjust depth). Do **not** delete `pluralize`
(D12). Engine inline copies are **DRY-08a → B12**; do not touch them.

## Out of scope (owned elsewhere — do NOT touch)

- `cli/errors.ts`'s `class CliError`/`cliError`/`isCliError`/`rethrowAsCli` definitions →
  **B05** (D2). You only add `withCliErrors`.
- `cli/commands/start.ts` split (`bootstrapSession`/dispatchers), `core/runtime/commands/registry.ts`
  predicates/messages, `brief-review.ts` pure-formatter split, `stores/project/config.ts`
  `config-persistence.ts`, `export/html-renderer.ts` CSS → **B11**. Build on the post-B11
  files; adopt within them.
- The engine routing logic now in `engine/facades/routing-preview.ts` and the
  `worker-packet-preview.ts` core-logic move → **B09**. Read its output; do not re-move it.
- `core/layout/` (relocated to `features/workflow/layout/`), `LayoutEvent` deletion,
  `predictCost` cache, `getProviderPricing` deletion → **B09**.
- `computeScrollWindow`/`maxVisible` **contract fix** (cap, D5) and the picker prop fixes →
  **B08** (NM-01). You only *adopt* the (already-capped) helper at the 3 DRY-49 sites.
- The `navigate` `assertNever` switch arm and closed-union exhaustiveness in `router.ts` →
  **B02**. You only refactor the two union type declarations (DRY-23).
- AS-02 (`if (!config) throw` is dead) at `headless.ts:79`/`run.ts:62` → **B16**. Move the
  guard **verbatim** into `resolveRunConfig`; do not delete it.
- RU-12 (`formatTokensShort` adoption), RU-13 (`capitalize` adoption), DRY-34
  (`readValidatedJson`/`readJsonl` readers) → validated under **B04/B05**, not B13. You may
  incidentally use `formatTokensShort`/`capitalize` where natural, but do not list them as
  B13 findings and do not build the readers.
- `pluralize`/`clamp`/`formatTaskId`/`wrapHard`/`renderMeterBar`/`resolveEditorCommand`/
  `cloneDetectedModel` deletions → forbidden for **B14** (D12). Engine-side `.diptych`
  (DRY-59a), engine pluralize (DRY-08a), all engine DRY rows → **B12**.
- `childrenOf`/`isOnActivePath` in `sessions/tree/store.ts` → **B14** (DC-13). `event-format.ts:61`
  binary stage glyph → not a TaskStatus map; leave it.
- All test files for PT-01/TB-08 and any test asserting on the touched behavior → **B15**
  (update only the tests your own change *breaks*; the white-box glyph/scroll test rewrites
  are B15's).

## Acceptance criteria

- [ ] Every finding ID in the table above is addressed in the code.
- [ ] `renderTable` exists in `src/cli/render-table.ts` and `ps`/`worktree`/`approval` render
  through it; worktree still narrows path/branch/name on a narrow terminal and approval still
  prints bold headers + a dim separator; `ps`/`worktree`/`approval` output is byte-identical to
  before on a wide terminal.
- [ ] `withCliErrors` exists in `cli/errors.ts`; all 17 `try/catch(rethrowAsCli)` sites route
  through it, and the single-call sites (snapshot restore/diff, detach) keep their post-call
  logic and `throw cliError(...)` for conflicts/diffs.
- [ ] `resolveRunConfig` is the one config-resolution path for `runRpc` and `runHeadless`;
  `printConfigWarnings` is the one warning printer (run/headless/spec); the `if (!config)`
  guard is preserved verbatim inside `resolveRunConfig`.
- [ ] `resumeSavedSession` is the one resume tail for `resume`/`continue`; both commands' no-state
  error messages and `continue`'s running-attach branch are unchanged.
- [ ] `writeJsonLine`/`parseJsonLine` (`cli/json-line.ts`) and `listSessionDirs` adopted at
  their sites; `reader.ts` still emits `Invalid JSON: …` on parse failure; `detach.ts` still
  returns silently.
- [ ] `router.ts` derives `RouteData`/`NavigateArgs` from shared payload shapes; B02's
  `assertNever` arm intact; navigation still typechecks.
- [ ] `PhaseTokens`/`PerTaskTokens` are exported from `stores/workflow/tokens.ts` and the
  drilldown overlay imports them (no re-declared field lists); both meter bars render identically
  via `renderMeterBar`.
- [ ] `useBriefData` delegates to `loadPlanEditorData` with no double `setReviewMetadata`.
- [ ] One `STATUS_GLYPH` map; `sidebar`/`evidence`/`task-summary` read it; contradictory glyphs
  resolved to one canonical set; `event-format.ts:61` untouched; no test files touched for PT-01.
- [ ] One `classifyReviewMetadata`/predicate module; `plan-review-scorecard`, the post-B11
  brief formatter, the post-B09 routing-preview, and `task-row.tsx` share it; routing-reason
  string-sniffing lives in exactly one place; no engine→features import introduced.
- [ ] The 3 DRY-49 sites route through the new `windowSlice` export in `picker-utils.ts`;
  `computeScrollWindow`/`availableRows` (B08's) are untouched; rendered output (indicators,
  indices) unchanged. `use-column-state.ts` imports `clampIndex` from `utils/indexing.ts`;
  local copy deleted.
- [ ] `resolveEditorCommand`/`cloneDetectedModel`/`wrapHard`/`formatTaskId` adopted at their
  sites; behavior unchanged; producers were confirmed to exist (no recreated helpers).
- [ ] `runPricingIdentity` in `core/providers/` adopted at `run/run.ts`, `task/budget-check.ts`
  (as fallback default, `state.* ??` precedence preserved), `use-cost-stats.ts`; the
  planner/implementer model asymmetry from `run.ts` is preserved.
- [ ] `.diptych` cli/core literals replaced with `DIPTYCH_DIR`/`getDiptychPath`; engine sites
  untouched.
- [ ] `createPromptChannel` backs both prompt-actions modules; public function signatures
  unchanged; supersede/cancel semantics preserved.
- [ ] `FILE_DROP_PATTERN` built from `SUPPORTED_IMAGE_EXTS`; `insertEntry` shared by
  `appendEntry`/`branchFrom` with dead `childrenOf`/`isOnActivePath` untouched;
  `isWorkflowAborted` adopted at the 3 sites.
- [ ] `pluralize` adopted at all CLI/UI inline `=== 1 ? '' : 's'` sites listed; `pluralize` not
  deleted; engine copies untouched.
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization; all imports use the
  `.js` extension; `src/engine/` introduces no `react`/`features`/`components`/`hooks` import; no
  decorative comments / section banners.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated only where this brief's change altered behavior).

## Tests

```bash
npm test -- src/cli/commands/ps.test.ts src/cli/commands/worktree.test.ts src/cli/commands/approval.test.ts src/cli/commands/snapshot.test.ts src/cli/commands/stats.test.ts src/cli/commands/status.test.ts src/cli/commands/detach.test.ts src/cli/commands/continue.test.ts src/cli/commands/handoff.test.ts src/cli/commands/explain.test.ts
npm test -- src/cli/rpc/run.test.ts src/cli/rpc/reader.test.ts src/cli/headless.test.ts src/cli/session-aliases.test.ts
npm test -- src/features/workflow/plan-review-scorecard.test.ts src/features/workflow/components/plan-editor.test.ts
npm test -- src/stores src/components/pickers src/components/composer/completion
npm test -- src/core/sessions/tree
npm run typecheck
npm run lint
```
