# B08 — Core / CLI / features parameter objects

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Eliminate the high-risk positional-parameter signatures in the **core**, **CLI**, and
**features/UI** layers: functions with adjacent same-typed arguments (multiple
`string | undefined`, multiple `unknown`, multiple `Config`, callback runs of one
type), leading/trailing boolean traps, and 4–7 positional params. Convert each to a
named options object (or context object) so every argument is name-bound at the call
site. Additionally fix one real TUI bug — `computeScrollWindow`'s `maxVisible` is used
as a *floor* but every picker passes it expecting a *cap* (D5) — and remove the two
parallel runner-kind / migration re-derivations in the migration/config code (DRY-41).
No behavior changes except the documented `computeScrollWindow` cap fix.

## Wave / ordering

- **Wave:** 4. **Runs after:** B01 (formatting sweep — every file is already reflowed),
  B02 (type-safety gate + switch exhaustiveness, which already touched
  `core/state/machine.ts` and `stores/project/config.ts`), and B03 (const-tuple enums +
  `z.infer` types). It runs **concurrently in the same wave as B06 and B07 but writes
  are serialized**; per the coordinator, B06 lands before B08, and B07 before/with B08.
  This matters because several call sites you must update live in files B06/B07 already
  converted to their own options objects — **build on their edits, never revert them**.
- **Decisions that bind this brief:**
  - **D5** — `computeScrollWindow`/`maxVisible` must behave as a **cap** (`Math.min` on
    visible rows). Keep the name `maxVisible`. This is an intended TUI behavior change
    (pickers will show ≤5 rows as their `maxVisible={5}` prop intends). Owner: **B08**.
  - **D1** (B02, already landed) — no incidental `!`, broad `as`, or `any`; the
    invariants grep gate enforces it. Keep your new code clean.

## File ownership

**Edit (yours, B08):**

- `src/components/pickers/picker-utils.ts` — `computeScrollWindow` cap fix (NM-01 / D5).
- `src/core/paths-io.ts` — `writeSpecFile` signature → `SpecFileRef` context (PD-27).
- `src/core/state/machine.ts` — `transition` trailing-opts only (PD-40). **Collision:**
  B02 already added switch exhaustiveness here; B12 will later add
  `rewindReset`/`resetToIdle`/REWIND dedup. **You own ONLY the `transition` signature at
  line ~150 and its `state-ops.ts` call site.** Do not touch the reducer bodies or the
  REWIND cases.
- `src/stores/project/config.ts` — `persistedValueForSave` + `persistedConfigForSave`
  options objects (PD-36). **Collision:** B02 already removed casts here; B11 will later
  extract `config-persistence.ts`. **You own ONLY the two functions' signatures
  (lines ~61 and ~85) and their internal callers in this file.** Do not extract files.
- `src/cli/rpc/reader.ts` — `createCommandReader` options object (PD-37).
- `src/engine/spec/prompts/constitution.ts` — `buildConstitutionPrompt` typed input (PD-38).
- `src/engine/spec/prompts/analyze.ts` — `buildAnalyzePrompt` typed input (PD-38).
- `src/components/input/segments.ts` — internal `buildSegmentsWithHighlight` options
  object (PD-29). (`buildSegments` already uses `BuildSegmentsParams` — leave it.)
- `src/core/layout/scroll-window.ts` — `getScrollWindowState` options object (PD-30).
  **Collision:** B09 later relocates the whole `core/layout/` dir (D7). **You own ONLY
  the param-object change; do NOT move/rename files.**
- `src/core/layout/workflow-rect.ts` — width/height helpers options objects (PD-30). Same
  B09 collision note.
- `src/core/layout/cost-chrome.ts` — `formatProjected` options object (PD-30). Same B09
  collision note.
- `src/features/workflow/keyboard.ts` — `handleReviewScroll` + `handleWorkflowCtrlChords`
  options objects (PD-31).
- `src/features/workflow/conversation-rows/row-format.ts` — `prefixedWrappedRows` +
  `cardRows` options objects (PD-32).
- `src/features/workflow/components/plan-editor/virtualization.ts` —
  `getVisibleTaskWindow` options object (PD-33).
- `src/features/runners/config-transforms.ts` — `commitCustomCommand` +
  `commitCustomModel` options objects (PD-34).
- `src/core/config/load/migrate.ts` — `inferLegacyKind` options object + DRY-41
  delegation to `inferKindFromTool` (PD-35 / DRY-41).
- `src/core/migration/legacy.ts` — `deriveSessionId` options object (PD-35).
- `src/core/migration/executor.ts` — DRY-41: `maybeMigrate` delegates detection to a
  shared helper (no parallel `existsSync` re-derivation).
- `src/features/workflow/hooks/use-plan-editor-keys.ts` — `usePlanEditorKeys` options
  object + drop `isActive` (PD-24).
- `src/components/composer/completion/command/hook.ts` — internal `buildSelectionKey`
  options object (PD-39).
- `src/components/pickers/two-column-picker/use-column-state.ts` — `useColumnState`
  options object (PD-39). **Do NOT** swap the local `clampIndex` for the util — that is
  DRY-50, owned by **B13**.
- **PD-41c long tail (options objects):**
  - `src/core/sessions/id/find-unused-id.ts` — `findUnusedId`.
  - `src/features/home/layout.ts` — already uses `HomeLayoutInput`; verify and mark PASS
    if the exported `getHomeLayout` is already object-form (it is). The internal
    `getContentAwareSessionLimit` (4 positional incl. boolean) is the real target.
  - `src/engine/spec/token-budget.ts` — `computeTokenBudget`.
  - `src/components/composer/history.ts` — `stepInputHistory`.
  - `src/features/workflow/input-hints.ts` — `resolveInputHint` (4 positional).
  - `src/engine/orchestrator/explain/sections.ts` — `buildReview` + `buildActivity`
    **signatures only** (PD-41c, line ~54/~69). **Do NOT** touch lines 138–237
    (`actualCostLabel`/`mergeTaskActivity` — that is DRY-27, owned by **B12**).
  - `src/features/workflow/conversation-rows/scroll.ts` — `computeConversationRowScroll`
    already uses `ConversationRowScrollInputs`; mark PASS if object-form (it is). No
    internal multi-positional helper here beyond `computeAnchoredScrollOffset` (4
    numbers) — convert that.

**Call-site files you must update (signature changes ripple here — update the call shape
ONLY, do not touch the other brief's concern in these files):**

- `writeSpecFile` (PD-27): `src/cli/commands/spec.ts`,
  `src/engine/orchestrator/clarifications.ts` *(B06)*, `.../planner-review.ts`,
  `.../planning/rewind.ts` *(B06)*, `.../planning/shared.ts` *(B06)*,
  `.../run/phases.ts` *(B06)*. Plus tests (see Tests).
- `transition` (PD-40): `src/engine/orchestrator/state-ops.ts` *(B06)* line 43.
- `buildConstitutionPrompt`/`buildAnalyzePrompt` (PD-38):
  `src/engine/orchestrator/planning/speckit.ts` *(B06)* lines 137/168.
- `commitCustomCommand`/`commitCustomModel` (PD-34):
  `src/features/runners/use-picker-actions.ts` lines 120/131.
- `prefixedWrappedRows`/`cardRows` (PD-32):
  `src/features/workflow/conversation-rows/event-rows.ts` (~40 call sites).
- `getVisibleTaskWindow` (PD-33): `src/features/workflow/components/plan-editor.tsx:103`.
- `getScrollWindowState` (PD-30):
  `src/features/workflow/components/conversation-flow/flow.tsx:63`.
- `handleReviewScroll`/`handleWorkflowCtrlChords` (PD-31):
  `src/features/workflow/hooks/use-workflow-keys.ts` lines 44/80.
- `createCommandReader` (PD-37): `src/cli/rpc/run.ts:235`.
- `computeTokenBudget` (PD-41c): `src/engine/spec/prompt-formatter.ts` *(B07)*.
- `stepInputHistory` (PD-41c): `src/components/composer/use-history.ts`.
- `resolveInputHint` (PD-41c): `src/features/workflow/screen.tsx`.
- `buildReview`/`buildActivity` (PD-41c): `src/engine/orchestrator/explain/explain.ts`,
  `.../evidence/review-packet/review-packet.ts`, `.../evidence/review-packet/build.ts`
  *(B06)*.
- `findUnusedId` (PD-41c): `src/core/sessions/lifecycle.ts`,
  `src/core/migration/legacy.ts`.
- `deriveSessionId` (PD-35): `src/core/migration/executor.ts`.
- `useColumnState` (PD-39): `src/components/pickers/two-column-picker/use-two-column-state.ts`.
- `inferLegacyKind` (PD-35) is module-private to `migrate.ts` — only one caller, line 131.

**Create:** none (all types are inline `interface`/`type` in their owning file).

**Delete:** none.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| NM-01 | high | `components/pickers/picker-utils.ts:29-37` | `computeScrollWindow`'s `maxVisible` must **cap** (`Math.min`), not floor (D5); keep prop name; verify session/skills pickers now show ≤5 rows |
| PD-24 | high | `features/workflow/hooks/use-plan-editor-keys.ts:117-123` | Options object; drop the leading `isActive` boolean trap (caller always passes `true`) |
| PD-27 | med | `core/paths-io.ts:81` | `SpecFileRef` context object `{ projectDir, sessionId }`; update all 11 call sites |
| PD-29 | med | `components/input/segments.ts:45-53` | Options object for internal `buildSegmentsWithHighlight` (7–8 positional) |
| PD-30 | m/l | `core/layout/{scroll-window:40, workflow-rect:7-21, cost-chrome:33}.ts` | Options objects: `getScrollWindowState` (3 nums+bool), `getWorkflow{Sidebar,Content}Width`, `formatProjected` (5) |
| PD-31 | med | `features/workflow/keyboard.ts:45-51` | Match the existing `ConversationScrollInput` pattern: `handleReviewScroll` + `handleWorkflowCtrlChords` take options objects |
| PD-32 | med | `features/workflow/conversation-rows/row-format.ts:43-78` | Options objects for `prefixedWrappedRows` (6–7, trailing bool) + `cardRows` (6, adjacent string/tone) |
| PD-33 | med | `features/workflow/components/plan-editor/virtualization.ts:38` | Options object for `getVisibleTaskWindow` (5 positional) |
| PD-34 | m/l | `features/runners/config-transforms.ts:35,47-53` | Options objects: `commitCustomCommand` (4) + `commitCustomModel` (5) |
| PD-35 | med | `core/config/load/migrate.ts:179` + `core/migration/legacy.ts:18` | Options objects: `inferLegacyKind` (4 adjacent `string\|undefined`) + `deriveSessionId` (3 adjacent strings + test-seam `Date`) |
| PD-36 | h/m | `stores/project/config.ts:61-67,85` | Options objects so each value is name-bound: `persistedValueForSave` (3 adjacent `unknown`) + `persistedConfigForSave` (3 adjacent `Config`) |
| PD-37 | med | `cli/rpc/reader.ts:4-9` | Options object: `createCommandReader` (4 positional, 3 same-typed callbacks) |
| PD-38 | med | `engine/spec/prompts/{constitution,analyze}.ts` | Typed input object mirroring `buildPlanPrompt`; 3 adjacent interchangeable strings each |
| PD-39 | med | `composer/completion/command/hook.ts:41` + `two-column-picker/use-column-state.ts:16` | Options objects: internal `buildSelectionKey` (5) + `useColumnState` (3 exported). (`picker-utils.ts:29` handled by NM-01.) |
| PD-40 | low | `core/state/machine.ts:150` | Keep `(state, action)`; fold `maxRetries`/`now` into trailing `opts?: { maxRetries?; now? }` |
| PD-41c | l–m | `find-unused-id.ts:4`, `home/layout.ts:19`, `token-budget.ts:16`, `composer/history.ts:17`, `input-hints.ts:6`, `explain/sections.ts:69`, `scroll.ts:7` | Options objects for the exported/boundary-crossing ones; mark already-object-form ones PASS (`getHomeLayout`, `computeConversationRowScroll`) and convert their multi-positional internal helpers |
| DRY-41 | med | `core/config/load/migrate.ts` + `runtime/build-runner.ts` + `core/migration/executor.ts` | Three parts: **(a)** `maybeMigrate` reuses `migrateCommand`'s legacy-dir detection (no parallel `existsSync` block); **(b)** `inferLegacyKind`'s **CLI-id** check delegates to `inferKindFromTool` (minimal shared logic only — see step 13b for why full delegation is NOT behavior-preserving); **(c)** `migrateV1ToV2`'s hand-mirrored top-level Config passthrough-key list (migrate.ts:80-101) derives from `ConfigSchema.shape` instead of a literal list |

> Cross-check vs Coverage summary (B08 = `PD-24,27,29..37,39,40,41c,35; NM-01; DRY-41`):
> PD-24 ✓, PD-27 ✓, PD-29 ✓, PD-30 ✓, PD-31 ✓, PD-32 ✓, PD-33 ✓, PD-34 ✓, PD-35 ✓,
> PD-36 ✓, PD-37 ✓, PD-38 ✓, PD-39 ✓, PD-40 ✓, PD-41c ✓, NM-01 ✓, DRY-41 ✓. None dropped.
> (Note: the coordinator's prose lists "PD-38?" under B07 with a question mark; the
> authoritative traceability row assigns **PD-38 to B08** — it is yours.)

## Required changes

Work top-down. After each numbered group, the file typechecks on its own.

### 1. NM-01 / D5 — `computeScrollWindow` is a CAP (`components/pickers/picker-utils.ts`)

Current `availableRows(rows, chrome, floor = 3)` returns `Math.max(rows - chrome, floor)`
— so the optional `maxVisible` passed into `computeScrollWindow` is used as a **floor**.
Pickers pass `maxVisible={5}` wanting *at most* 5 rows.

- Change `computeScrollWindow` so that when `maxVisible` is supplied it **caps** the
  visible count: `const base = availableRows(terminalRows, chromeRows); const visible =
  maxVisible !== undefined ? Math.min(base, maxVisible) : base;`. Keep `availableRows`'s
  own `floor=3` default for the *un-capped* baseline (do not pass `maxVisible` as the
  floor anymore). Keep the returned shape `{ maxVisible: visible, scrollOffset, … }`.
- Open every `computeScrollWindow(... , N)` caller and confirm the intended cap behavior.
  Find them: `grep -rn "computeScrollWindow" src --include=*.ts --include=*.tsx`. The
  session/skills single-column pickers pass a numeric `maxVisible`; verify they now
  yield ≤ that many rows on a tall terminal. Do **not** change `availableRows`'s public
  contract beyond removing its use as the cap (it is still used elsewhere as a floor).

### 2. PD-27 — `writeSpecFile` SpecFileRef context (`core/paths-io.ts`)

- Add `export interface SpecFileRef { projectDir: string; sessionId: string; }`.
- New signature:
  `export function writeSpecFile(ref: SpecFileRef, filename: string, content: string, metadata?: SpecMetadata | null): void`.
  Body uses `ref.projectDir`/`ref.sessionId` (replace the two positional params).
- Update the 6 production call sites to pass `{ projectDir, sessionId }`:
  - `cli/commands/spec.ts:67`
  - `engine/orchestrator/clarifications.ts:75` *(B06 file — call shape only)*
  - `engine/orchestrator/planner-review.ts:30`
  - `engine/orchestrator/planning/rewind.ts:45,135` *(B06)*
  - `engine/orchestrator/planning/shared.ts:52,71,206,225` *(B06)*
  - `engine/orchestrator/run/phases.ts:132` *(B06; currently
    `writeSpecFile(opts.wctx.projectDir, opts.wctx.sessionId, …)` → `writeSpecFile({
    projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId }, …)`)*.
- Leave `readSpecFile`/`readSpecFileOrEmpty`/`writeProjectFile` signatures unchanged.
  The audit notes they "share the prefix" but the finding's file:line is `writeSpecFile`
  specifically; converting the readers too is out of PD-27's required change (and would
  balloon the call-site churn). It is acceptable that `SpecFileRef` exists while the
  readers stay positional — do not let that inconsistency tempt a wider refactor.
- `SpecFileRef` is intentionally **core-local** (defined in `core/paths-io.ts`). Do
  **not** reuse B06's `SessionRef`/`WorkflowContext` — `core/` cannot import the
  orchestrator (engine layer). It is a plain `{ projectDir, sessionId }` record.

### 3. PD-40 — `transition` trailing opts (`core/state/machine.ts`)

- New signature: `export function transition(state: WorkflowState, action: StateAction,
  opts: { maxRetries?: number; now?: Date } = {}): WorkflowState`. Inside, derive
  `const maxRetries = opts.maxRetries ?? 3;` and `const now = opts.now ?? new Date();`.
- Keep the reducer body and all `case` arms exactly as B02 left them (do not touch the
  REWIND cases — B12 owns those).
- Update the only 3-arg production caller `engine/orchestrator/state-ops.ts:43`:
  `transition(base, action, maxRetries)` → `transition(base, action, { maxRetries })`.
  (`transitionAndSave` keeps its own positional `maxRetries?` param; only the inner call
  changes.)
- The `use-workflow-runner.ts:107` caller is 2-arg — no change.
- **Test call sites that pass the 3rd positional `maxRetries`** must also change:
  `core/state/machine.test.ts:270` and `:284` call `transition(state, {…}, 5)` →
  `transition(state, {…}, { maxRetries: 5 })`. (All other `transition(...)` calls in the
  test suite are 2-arg and need no change; confirm with
  `grep -rn "transition(.*, [0-9]" src/core/state/machine.test.ts`.)

### 4. PD-36 — config persistence options (`stores/project/config.ts`)

- `persistedValueForSave(persisted, effective, updated, path, changedPaths)` →
  single options object, e.g.
  `interface PersistedValueArgs { persisted: unknown; effective: unknown; updated: unknown; path: Path; changedPaths: readonly Path[]; }`
  and `function persistedValueForSave(args: PersistedValueArgs): unknown`. Update the
  recursive self-call (line ~80) and the call from `persistedConfigForSave` (line ~98).
- `persistedConfigForSave(persisted, effective, updated, options?)` → name-bind the three
  `Config` values:
  `interface PersistedConfigArgs { persisted: Config; effective: Config; updated: Config; options?: SaveOptions; }`
  and `function persistedConfigForSave(args: PersistedConfigArgs): Config`. Update its
  caller in `save()` (line ~126): `persistedConfigForSave({ persisted: diskConfig,
  effective: config, updated, options })`.
- These are module-private; no external call sites. Do **not** extract a new file (B11).

### 5. PD-37 — `createCommandReader` options (`cli/rpc/reader.ts`)

- `interface CommandReaderOptions { stream: NodeJS.ReadableStream; onCommand: (cmd: RpcCommand) => void; onError: (err: string) => void; onClose?: (() => void) | undefined; }`
  and `createCommandReader(options: CommandReaderOptions): { close: () => void }`.
- Update `cli/rpc/run.ts:235` to pass the named object.

### 6. PD-38 — prompt builders typed input (`engine/spec/prompts/{constitution,analyze}.ts`)

- `buildConstitutionPrompt(feature, spec, constitutionContent)` →
  `interface ConstitutionPromptInput { feature: string; spec: string; constitutionContent: string; }`
  and `buildConstitutionPrompt(input: ConstitutionPromptInput): string`.
- `buildAnalyzePrompt(spec, plan, tasks)` →
  `interface AnalyzePromptInput { spec: string; plan: string; tasks: string; }`
  and `buildAnalyzePrompt(input: AnalyzePromptInput): string`.
- Update `engine/orchestrator/planning/speckit.ts:137`
  (`buildConstitutionPrompt({ feature: opts.feature, spec: '', constitutionContent })`)
  and `:168` (`buildAnalyzePrompt({ spec: specText, plan: planText, tasks: tasksText })`).
  Update the colocated `*.test.ts` calls too.

### 7. PD-29 — `buildSegmentsWithHighlight` options (`components/input/segments.ts`)

- This helper is internal (one caller at line ~124). Convert its 7 positionals to one
  object, e.g.
  `interface HighlightSegmentArgs { highlight: { start: number; end: number }; textBefore: string; textAfter: string; cursorIndex: number; showCursor: boolean; valueLength: number; formatText: FormatText; }`.
  Update the single call site in `buildSegments`. Leave the public `buildSegments` /
  `BuildSegmentsParams` untouched.

### 8. PD-30 — layout helpers options (`core/layout/{scroll-window,workflow-rect,cost-chrome}.ts`)

- `getScrollWindowState(totalHeight, viewportHeight, scrollOffset, hasNewEvents)` →
  `interface ScrollWindowStateInput { totalHeight: number; viewportHeight: number; scrollOffset: number; hasNewEvents: boolean; }`.
  Update caller `features/workflow/components/conversation-flow/flow.tsx:63`. (Leave
  `computeScrollMaxOffset` as-is — it is a small internal used by `scroll.ts`; not
  flagged.)
- `workflow-rect.ts`: `getWorkflowSidebarWidth(cols, sidebarVisible, isSmall)` and
  `getWorkflowContentWidth(cols, sidebarVisible, isSmall)` have adjacent booleans. Route
  them through a small `interface SidebarWidthInput { cols: number; sidebarVisible: boolean; isSmall: boolean; }`
  (or reuse fields of the existing `WorkflowContentRectInput`). Update internal callers
  in the same file (`getWorkflowContentWidth`, `getWorkflowContentRect`) and any external
  callers (`grep -rn "getWorkflowSidebarWidth\|getWorkflowContentWidth" src`). Leave
  `getWorkflowContentRect` (already object-form) and the `getWorkflowMiddleRows` family
  (trailing optional `cols?`, single concern) as-is unless an external caller passes
  adjacent same-typed args — they don't.
- `cost-chrome.ts`: `formatProjected(completedCount, totalActualCost, prediction, totalTasks, pricingState?)`
  → options object
  `interface ProjectedCostInput { completedCount: number; totalActualCost: number; prediction: CostPrediction | null; totalTasks: number; pricingState?: CostChromePricingState; }`.
  Update its internal caller in `buildCostStatusLineLayout` (line ~86) and external
  callers (`grep -rn "formatProjected" src`).

### 9. PD-31 — keyboard handlers options (`features/workflow/keyboard.ts`)

- `handleReviewScroll(input, key, reviewScrollOffset, reviewLineCount, visibleHeight)` →
  `interface ReviewScrollInput { input: string; key: Key; reviewScrollOffset: number; reviewLineCount: number; visibleHeight: number; }`.
- `handleWorkflowCtrlChords(input, key, isSmall, sections, findLatestDiff)` →
  `interface WorkflowCtrlChordsInput { input: string; key: Key; isSmall: boolean; sections: Section[]; findLatestDiff: (sections: Section[]) => number | null; }`.
- Mirror the existing `ConversationScrollInput` style already in this file. Update
  `features/workflow/hooks/use-workflow-keys.ts:44,80`.

### 10. PD-32 — row-format options (`features/workflow/conversation-rows/row-format.ts`)

- `prefixedWrappedRows(keyPrefix, text, width, tone, role, bold=false)` →
  `interface PrefixedRowsInput { keyPrefix: string; text: string; width: number; tone: ConversationRowTone; role: GutterRole; bold?: boolean; }`.
- `cardRows(keyPrefix, label, value, width, labelTone, valueTone='textDim')` →
  `interface CardRowsInput { keyPrefix: string; label: string; value: string | undefined; width: number; labelTone: ConversationRowTone; valueTone?: ConversationRowTone; }`.
- Update **all callers** in `features/workflow/conversation-rows/event-rows.ts`
  (~40 sites; `grep -n "prefixedWrappedRows\|cardRows" src/features/workflow/conversation-rows/event-rows.ts`).
  This is mechanical: wrap each positional call in `{ keyPrefix, text, … }`. Keep
  `row`/`blankRow`/`wrapText`/`wrapRows`/`rowText` unchanged (single/simple params).

### 11. PD-33 — virtualization options (`features/workflow/components/plan-editor/virtualization.ts`)

- `getVisibleTaskWindow(tasks, cursor, expandedIds, metadata, rowBudget)` →
  `interface VisibleTaskWindowInput { tasks: Task[]; cursor: number; expandedIds: ReadonlySet<string>; metadata: ReadonlyMap<string, PlanTaskReviewMetadata>; rowBudget: number; }`.
- Leave `getTaskEditorRowHeight(task, isExpanded, metadata?)` as-is (3 distinct types, no
  adjacent same-typed run).
- Update caller `features/workflow/components/plan-editor.tsx:103`.

### 12. PD-34 — config-transforms options (`features/runners/config-transforms.ts`)

- `commitCustomCommand(config, role, command, kind)` →
  `interface CommitCustomCommandInput { config: Config; role: 'planner' | 'implementer'; command: string; kind: 'shell' | 'agent'; }`.
- `commitCustomModel(config, role, selection, modelName, customModels)` →
  `interface CommitCustomModelInput { config: Config; role: 'planner' | 'implementer'; selection: PickerOption; modelName: string; customModels: string[]; }`.
- Leave `commitPlannerSelection`/`commitImplementerSelection` (3 distinct-typed params)
  as-is — not flagged. Update callers `features/runners/use-picker-actions.ts:120,131`.

### 13. PD-35 + DRY-41 — migration / config-migration options & dedup

- **`core/config/load/migrate.ts` `inferLegacyKind`** (line 179, 4 adjacent
  `string|undefined` + role):
  - Convert to one object:
    `interface LegacyKindInput { legacyKind?: string; tool?: string; command?: string; apiBase?: string; role: 'planner' | 'implementer'; }`
    and `function inferLegacyKind(input: LegacyKindInput): RunnerKind`.
  - **DRY-41 (b) — delegate ONLY the CLI-id check; this is the single instruction, do
    NOT also try full delegation.** Full delegation is **not** behavior-preserving:
    `inferKindFromTool('ollama')` (or any `KNOWN_API_PROVIDERS` id) returns `'api'`, and
    `inferKindFromTool('shell'|'agent'|'agent-sdk')` returns those kinds — but the current
    `inferLegacyKind` only treats `tool` as a CLI signal (`includes(CLI_TOOL_IDS, tool)`)
    and otherwise falls through to `apiBase ? 'api' : command ? 'shell' : role==='planner'
    ? 'cli' : 'api'`. So for `tool='ollama'`, planner, no apiBase: old → `'cli'`, full
    delegation → `'api'` (a migration-output change). Therefore: import `inferKindFromTool`
    from `core/config/runtime/build-runner.ts` and replace **only** the CLI-id line —
    `if (input.tool && includes(CLI_TOOL_IDS, input.tool)) return 'cli';` becomes
    `if (input.tool && inferKindFromTool(input.tool) === 'cli') return 'cli';`. Keep the
    rest of the tail (`apiBase`/`command`/role fallback) exactly as-is. This is the only
    genuinely duplicated decision (CLI-id membership) and keeps migration output
    byte-identical. Keep the two `legacyKind` checks (RUNNER_KINDS, CLI_TOOL_IDS)
    unchanged. Update the single caller at line 131 to the object form.
- **DRY-41 (c) — single-source the v1→v2 passthrough-key list (`core/config/load/migrate.ts:80-101`).**
  `migrateV1ToV2` hand-mirrors the top-level keys of `ConfigSchema`
  (`core/schemas/config.ts:81-130`): `validation, theme, shikiTheme, sessions, escalation,
  codebase, hooks, otel, snapshots, palette, approval, implementerProfiles,
  plannerEstimateReview, autoSplitOverflow`. This list already drifts (the schema has a
  `trust` key the migrator omits). Replace the literal passthrough enumeration with a
  derivation from the schema so the two cannot drift:
  - Build the passthrough-key set from `Object.keys(ConfigSchema.shape)` minus the keys
    `migrateV1ToV2` handles specially (`version`, `planner`, `implementer`, `workflow`)
    — i.e. iterate the remaining schema keys and copy `obj[key]` when present.
  - Keep the special handling intact: `version: 2`, `planner`/`implementer` via
    `migrateRunnerV1ToV2`, `workflow` via `migrateWorkflowV1ToV2`.
  - Import `ConfigSchema` from `../../schemas/config.js` (a core→core import; allowed).
    Verify no import cycle is introduced (`migrate.ts` is imported by `load/load.ts`;
    `config.ts` is a leaf schema — safe). If a cycle does surface at typecheck, fall back
    to exporting a single `CONFIG_PASSTHROUGH_KEYS` const tuple from `config.ts` and
    consume it in both `migrate.ts` and (if it exists) any other passthrough site, instead
    of reading `.shape`. **This changes one observable thing — `trust` now passes through
    v1→v2 where it previously did not.** That is a correctness fix (the field was being
    silently dropped on legacy migration), not a regression; note it for the validator and
    add/adjust a `migrate` test asserting a v1 config with `trust` retains it.
- **`core/migration/legacy.ts` `deriveSessionId`** (line 18, 3 adjacent strings + `now`):
  - Convert to `interface DeriveSessionIdInput { feature: string; startedAt: string; projectDir: string; now?: Date; }`
    and `deriveSessionId(input: DeriveSessionIdInput): string`.
  - Update caller `core/migration/executor.ts:62`:
    `deriveSessionId({ feature, startedAt, projectDir })`.
- **`core/migration/executor.ts` DRY-41 detection dedup:** `maybeMigrate` (line 100)
  duplicates `migrateCommand`'s `legacyCurrent`/`tinySpecCurrent` `existsSync` detection.
  Extract a module-private helper
  `function findLegacySourceDir(projectDir: string): string | null` that returns the
  first existing of `[join(projectDir, DIPTYCH_DIR, 'current'), join(projectDir,
  '.tiny-spec', 'current')]` or `null`. Use it in **both** `migrateCommand` (replace the
  `if (existsSync(legacyCurrent)) … else if … else return not-needed` block, returning
  `{ status: 'not-needed' }` when `null`) and `maybeMigrate` (`return findLegacySourceDir(
  projectDir) === null ? { status: 'not-needed' } : migrateCommand(projectDir)`).
  Behavior is unchanged.

### 14. PD-24 — `usePlanEditorKeys` options (`features/workflow/hooks/use-plan-editor-keys.ts`)

- Signature `usePlanEditorKeys(isActive, onSave, sessionDir, onTogglePacketPreview?,
  onRegenerateFlagged?)` → options object **without `isActive`**:
  `interface PlanEditorKeysOptions { onSave: () => Promise<void>; sessionDir: string; onTogglePacketPreview?: (() => void) | undefined; onRegenerateFlagged?: (() => Promise<void>) | undefined; }`
  and `usePlanEditorKeys(options: PlanEditorKeysOptions): void`.
- The hook's `useInput` `isActive` was `isActive && !isOverlayOpen`; since the only
  caller passes `true`, replace with `!isOverlayOpen`.
- Update caller `features/workflow/components/plan-editor.tsx:56`:
  `usePlanEditorKeys({ onSave: save, sessionDir: sessionDirPath, onTogglePacketPreview:
  () => setIsPacketPreviewOpen(open => !open), onRegenerateFlagged })`.

### 15. PD-39 — completion/picker selection options

- `components/composer/completion/command/hook.ts` internal
  `buildSelectionKey(currentScreen, phase, query, filtered, fuzzyMatch)` (line 41) → one
  object `{ currentScreen, phase, query, filtered, fuzzyMatch }`. Update the single call
  at line 83. (The `reference/hook.ts` `buildSelectionKey` is 2-arg — not flagged; leave
  it.)
- `components/pickers/two-column-picker/use-column-state.ts` `useColumnState(source,
  filterFn, initialIndex)` (line 16) → object
  `interface ColumnStateInput<T> { source: T[]; filterFn: (item: T, query: string) => boolean; initialIndex: number; }`
  and `useColumnState<T>(input: ColumnStateInput<T>): ColumnStateHook<T>`. Update caller
  `components/pickers/two-column-picker/use-two-column-state.ts`. **Leave the local
  `clampIndex`** — replacing it with `utils/indexing.clampIndex` is DRY-50 (B13).

### 16. PD-41c long tail

For each, convert to an options object **only when** there is an adjacent same-typed run,
boolean trap, or 4+ positional, and update callers. Mark PASS (in your validator notes)
any already in object form.

- `core/sessions/id/find-unused-id.ts` `findUnusedId(root, base, suffixer,
  maxCollisionAttempts=999)` → `interface FindUnusedIdInput { root: string; base: string;
  suffixer: (base: string, collisionIndex: number) => string; maxCollisionAttempts?: number; }`.
  Update callers `core/sessions/lifecycle.ts` and `core/migration/legacy.ts:28`.
- `features/home/layout.ts`: `getHomeLayout` already takes `HomeLayoutInput` → **PASS**.
  Convert internal `getContentAwareSessionLimit(rows, isSmall, logoTier,
  inputBottomMargin)` (line 19; leading `number, boolean` adjacency) to an object and
  update its single internal caller.
- `engine/spec/token-budget.ts` `computeTokenBudget(system, taskBody, contextLength,
  modelId?)` → `interface TokenBudgetInput { system: string; taskBody: string;
  contextLength: number; modelId?: string; }`. Update caller
  `engine/spec/prompt-formatter.ts` *(B07 file — call shape only)*. (Leave
  `truncateMiddle` — distinct-typed params.)
- `components/composer/history.ts` `stepInputHistory(entries, state, direction,
  currentValue)` → `interface StepInputHistoryInput { entries: string[]; state:
  InputHistoryNavigationState; direction: 'up' | 'down'; currentValue: string; }`. Update
  caller `components/composer/use-history.ts`.
- `features/workflow/input-hints.ts` `resolveInputHint(cancelled, inputHint, inputMode,
  phase)` → `interface InputHintInput { cancelled: boolean; inputHint: string; inputMode:
  InputMode; phase: Phase; }`. Update caller `features/workflow/screen.tsx`. (Leave
  `resolveAttachInputHint(status)` — single param.)
- `engine/orchestrator/explain/sections.ts` — convert **signatures only**:
  - `buildActivity(packet, state, events)` (line ~54) → `interface ActivityInput {
    packet: ReviewPacket | null; state: WorkflowState | null; events: SessionLogEventEntry[]; }`.
  - `buildReview(sessionId, packet, state, events, artifacts)` (line ~69) → `interface
    ReviewInput { sessionId: string; packet: ReviewPacket | null; state: WorkflowState |
    null; events: SessionLogEventEntry[]; artifacts: RunExplainArtifact[]; }`.
  - Update callers `explain/explain.ts`, `evidence/review-packet/review-packet.ts`,
    `evidence/review-packet/build.ts` *(B06 file — call shape only)*. **Do NOT** touch
    `actualCostLabel`/`baselineCostLabel`/`taskStatusActivity`/`skippedActivity` bodies
    (lines 138–237) — that is DRY-27 (B12).
- `features/workflow/conversation-rows/scroll.ts`: `computeConversationRowScroll` already
  takes `ConversationRowScrollInputs` → **PASS**. Convert internal
  `computeAnchoredScrollOffset(rawScrollOffset, heightAtScroll, totalDynamicHeight,
  maxOffset)` (4 adjacent numbers) to an object and update its single internal caller.

## Out of scope (owned elsewhere — do NOT touch)

- `core/state/machine.ts` reducer bodies, REWIND cases, `rewindReset`/`resetToIdle`,
  `RESOLVE_PENDING_RECOVERY` payload → **B12 / B14**. You touch only `transition`'s
  signature + the `state-ops.ts` call.
- Extracting `config-persistence.ts` from `stores/project/config.ts` → **B11**.
- Relocating `core/layout/` and deleting `LayoutEvent` → **B09 (D7)**. You only change
  param shapes inside `scroll-window.ts`/`workflow-rect.ts`/`cost-chrome.ts`; do not move
  or rename them, do not touch `core/layout/event-types.ts`.
- `core/layout/workflow-rect.ts:110 getReviewContentHeight` thin pass-through + cost-chrome
  test-only exports → **B16 (OE-03)**. Do not inline/privatize them.
- `explain/sections.ts:138-237` (`formatKnownCost`/`mergeTaskActivity` extraction) →
  **B12 (DRY-27 / RU-08)**.
- `two-column-picker/use-column-state.ts` local `clampIndex` → util swap is **B13
  (DRY-50)**.
- `inferKindFromTool` itself in `build-runner.ts` (you import & reuse it; do not change
  its signature — that's the B07/PD long-tail territory if anything).
- `WorkflowContext`/`SessionRef`/orchestrator param objects (clarifications, queue,
  state-ops `addUsageAndSave`, planning/shared fn bodies, run/init, run/phases bodies,
  evidence/persistence, validation, escalation) → **B06**. In B06-owned files you ONLY
  re-shape the `writeSpecFile`/`transition`/`buildReview`/`buildConstitutionPrompt`/
  `buildAnalyzePrompt`/`computeTokenBudget` call sites — never their `WorkflowContext`
  conversions.
- `prompt-formatter.ts` own signatures (PD-21) → **B07**. You touch only the
  `computeTokenBudget` call there.
- `cli/commands/start.ts`: the collision map row reads `start.ts | B08 → B11 | B08:
  param fixes`, but **no B08 finding row above and no listed call-site touches `start.ts`**
  (it has no `writeSpecFile`/`transition`/etc. call from this brief's set). Reconciliation:
  there is nothing for B08 to do in `start.ts`; the `bootstrapSession` + dispatcher split
  is **B11**. Do not refactor `start.ts` here.

## Acceptance criteria

- [ ] Every finding ID above (NM-01, PD-24, PD-27, PD-29, PD-30, PD-31, PD-32, PD-33,
  PD-34, PD-35, PD-36, PD-37, PD-38, PD-39, PD-40, PD-41c, DRY-41) is addressed in code.
- [ ] `computeScrollWindow` caps when `maxVisible` is supplied; a single-column picker
  with `maxVisible={5}` on a 40-row terminal yields ≤5 visible rows (D5). Confirm via the
  picker-utils test and the session/skills picker tests.
- [ ] `usePlanEditorKeys` no longer accepts `isActive`; the plan editor still gates input
  on overlay-open only, and its keys still work (`plan-editor.test.ts` green).
- [ ] `writeSpecFile` takes `(ref: SpecFileRef, filename, content, metadata?)`; all 6
  production callers + tests compile and pass.
- [ ] Every converted function: each former positional arg is now a named field; no
  call site relies on positional order for the converted params.
- [ ] DRY-41 (a): `maybeMigrate` and `migrateCommand` share one `findLegacySourceDir`;
  session-migration output byte-identical (`executor.test.ts` green).
- [ ] DRY-41 (b): `inferLegacyKind`'s CLI-id check goes through `inferKindFromTool`; the
  `apiBase`/`command`/role fallback is unchanged; config-migration kind output
  byte-identical (`migrate` + `build-runner.test.ts` green).
- [ ] DRY-41 (c): `migrateV1ToV2`'s passthrough keys derive from `ConfigSchema` (no
  literal list); a v1 config carrying `trust` now retains it post-migration (new/updated
  `migrate` test asserts this — the only intended output delta).
- [ ] You did not revert any B06/B07/B02 edit in shared files (`state-ops.ts`,
  `clarifications.ts`, `rewind.ts`, `planning/shared.ts`, `run/phases.ts`,
  `prompt-formatter.ts`, `review-packet/build.ts`, `speckit.ts`, `machine.ts`,
  `config.ts`).
- [ ] No new `!` / broad `as` / `any` / barrels / non-`Error` classes / memoization
  (`useMemo`/`useCallback`/`React.memo`); all imports use the `.js` extension; no
  decorative comments; `src/engine/` adds no `react`/`ink`/`features` import.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where a signature changed).

## Tests

```bash
npm test -- \
  src/components/pickers/picker-utils \
  src/components/pickers/single-column-picker \
  src/components/pickers/two-column-picker \
  src/components/composer/completion \
  src/components/composer/history \
  src/components/input/segments \
  src/core/paths-io \
  src/core/state/machine \
  src/stores/project/config \
  src/cli/rpc/reader \
  src/engine/spec/prompts/constitution \
  src/engine/spec/prompts/analyze \
  src/engine/spec/formatter \
  src/core/layout/scroll-window \
  src/core/layout/workflow-rect \
  src/core/layout/cost-chrome \
  src/features/workflow/keyboard \
  src/features/workflow/conversation-rows \
  src/features/workflow/components/plan-editor \
  src/features/runners/config-transforms \
  src/core/config/load \
  src/core/config/runtime/build-runner \
  src/core/migration \
  src/core/sessions \
  src/features/home/layout \
  src/engine/spec/token-budget \
  src/engine/orchestrator/explain \
  src/engine/orchestrator/final-review \
  src/engine/orchestrator/approval \
  src/engine/orchestrator/planning \
  src/cli/rpc/run
npm run typecheck
npm run lint
```
