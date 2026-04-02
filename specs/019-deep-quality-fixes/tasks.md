# Tasks: Deep Code Quality Fixes

**Input**: Design documents from `/specs/019-deep-quality-fixes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Test tasks are included for bug fixes where regression tests are critical. No TDD — tests are written alongside fixes.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No project initialization needed — this is an existing codebase. Phase is empty.

---

## Phase 2: Foundational

**Purpose**: No blocking prerequisites — all user stories are independent of each other.

---

## Phase 3: User Story 1 — Code Patch Integrity (Priority: P1)

**Goal**: Fix silent data corruption when AI-generated code contains `$` characters (template literals, regex) and is applied via search/replace patching.

**Independent Test**: Apply a patch containing `${variable}` and `$1` patterns, verify output is verbatim.

- [x] T001 [US1] Fix `String.replace` dollar sign substitution bug by using function-form replacement `() => replace` in `src/engine/apply.ts:54`
- [x] T002 [US1] Add test cases for `$` substitution scenarios (`${var}`, `$1`, `$&`, `$$`) in `tests/implementer.test.ts` (or new `tests/apply.test.ts` section)

**Checkpoint**: Code patches with dollar signs produce verbatim output.

---

## Phase 4: User Story 2 — Workflow Continuity on External Changes (Priority: P1)

**Goal**: Fix workflow hang when user types "continue" at external changes prompt, and fix memory leak when aborting during active prompts.

**Independent Test**: Trigger external changes prompt, type "continue", verify workflow resumes. Abort during prompt, verify no leaked promises.

- [x] T003 [P] [US2] Add "continue" command handler in `handleInput` function in `src/hooks/use-workflow.ts` (alongside existing approve/edit/comment/quit handlers around line 84-101)
- [x] T004 [P] [US2] Fix `resetMode` in `src/hooks/use-input-mode.ts:33-37` to resolve pending promise with `{ approved: false }` before nulling the resolver ref

**Checkpoint**: External changes prompt handles all documented responses. Abort during prompt is clean.

---

## Phase 5: User Story 3 — Retry Prompt Quality (Priority: P1)

**Goal**: Ensure retry prompts include full project context and the escalation cascade passes the most recent error to each tier.

**Independent Test**: Trigger task failure, verify retry prompt includes project name/runtime. Verify tier-2 receives tier-1 error.

- [x] T005 [P] [US3] Fix `formatRetryPrompt` in `src/engine/spec/formatter.ts:197` to forward `context` parameter to `buildTaskSections(task, context)`
- [x] T006 [P] [US3] Add optional `contextLength` parameter to `formatRetryPrompt` and `buildFullRetryPrompt` in `src/engine/spec/formatter.ts` and apply `computeTokenBudget` + `resolveCodeContext` for `task.currentCode`
- [x] T007 [US3] Fix `handleRetryAndEscalation` in `src/engine/orchestrator/task-runner.ts:210-214` — have `runTier1Hint` return its validation error, pass it (instead of `retries.lastError`) to `runTier2Full`

**Checkpoint**: Retry prompts include project context. Tier-2 escalation has fresh error context.

---

## Phase 6: User Story 4 — CLI Flag Correctness (Priority: P1)

**Goal**: Make `--auto` flag actually enable auto-approval on all commands, and add `--no-fullscreen` to the resume command.

**Independent Test**: Run with `--auto`, verify no prompts. Run resume with `--no-fullscreen`, verify no alternate screen.

- [x] T008 [US4] Wire `--auto` flag in all three command action handlers in `src/cli.ts` — apply `opts.auto` to `config.workflow.autoApproveSpec = true` and `config.workflow.autoApprovePlan = true` after `loadConfig` in start (line ~165), spec (line ~230), and resume (line ~310)
- [x] T009 [US4] Add `.option('--no-fullscreen', 'Disable fullscreen alternate screen buffer')` to the resume command in `src/cli.ts:288` and use same `useFullscreen` logic as the start command

**Checkpoint**: All CLI flags produce their documented effect.

---

## Phase 7: User Story 5 — Subprocess Lifecycle Safety (Priority: P1)

**Goal**: Fix race condition in process registry, timer leak on spawn failure, and add SIGKILL escalation for unkillable processes.

**Independent Test**: Spawn missing command, verify no ghost registry entry and no dangling timer. Kill all processes, verify none survive.

- [x] T010 [P] [US5] Fix `activeProcesses.add(proc)` ordering in `spawnWithStreaming` and `runCommand` in `src/utils/process.ts` — move `add` to immediately after `spawn()`, before event handler registration
- [x] T011 [P] [US5] Fix timer leak in `runCommand` in `src/utils/process.ts:79-102` — move `setTimeout` before event handlers, clear timer in both `error` and `close` handlers, add `settled` guard
- [x] T012 [US5] Add SIGKILL escalation to `killProcess` in `src/utils/process.ts:5-9` — after SIGTERM, set 5s timeout, probe with signal 0, send SIGKILL if still alive (match pattern from `src/engine/implementers/agent.ts:50-61`)
- [x] T013 [US5] Add/extend tests in `tests/process.test.ts` for: spawn ENOENT leaves no ghost entry in `activeProcesses`, timer is cleared on spawn error, `killProcess` escalates to SIGKILL

**Checkpoint**: Subprocess lifecycle is consistent — no ghost entries, no leaked timers, reliable cleanup.

---

## Phase 8: User Story 6 — Task Dependency Resolution (Priority: P1)

**Goal**: Fix quoted `depends_on` bare values so topological sort resolves correctly.

**Independent Test**: Parse task file with `depends_on: "T001"`, verify dependency resolves.

- [x] T014 [P] [US6] Fix `parseDependsOnValue` in `src/engine/spec/parser.ts:96` — add `.replace(/^['"]|['"]$/g, '')` to the bare-value return path
- [x] T015 [P] [US6] Add test case for quoted bare `depends_on` values in `tests/formatter.test.ts` (or appropriate parser test)

**Checkpoint**: Quoted dependency values are correctly parsed and resolved.

---

## Phase 9: User Story 7 — Planner Backend Consistency (Priority: P2)

**Goal**: Fix escalation model override, shell planner locality, unnecessary type assertion, and DRY the SDK availability check.

**Independent Test**: Configure non-default model, trigger escalation, verify correct model used. Configure shell planner, verify local cost calculation.

- [x] T016 [P] [US7] Fix `agent-sdk.ts` escalation in `src/engine/planners/agent-sdk.ts:101-103` — change `model: DEFAULT_MODEL` to `model: model` (use the user-configured model variable)
- [x] T017 [P] [US7] Fix `SHELL_PRICING` in `src/engine/planners/shell.ts:45` — change `isLocal: false` to `isLocal: true`
- [x] T018 [P] [US7] Remove unnecessary type assertion in `src/engine/planners/aider.ts:50` — replace `(config.planner as { model?: string }).model` with `config?.planner.model`
- [x] T019 [P] [US7] DRY `isAvailable` in `src/engine/planners/agent-sdk.ts:109-115` — replace inline SDK import with `await loadSdk()` call (already defined at lines 6-15)

**Checkpoint**: All planner backends use configured model for escalation, report accurate locality, and have no redundant code.

---

## Phase 10: User Story 8 — Dead Code Removal (Priority: P2)

**Goal**: Remove all unused files, exports, props, and wire disconnected features.

**Independent Test**: Verify all exports are imported, all files are reachable, build compiles clean.

- [x] T020 [US8] Delete `src/ui/summary.tsx` (278 lines, never imported — app uses `src/screens/summary.tsx`)
- [x] T021 [US8] Wire `costBreakdown` in `buildSummary` in `src/engine/orchestrator/cost.ts:50-72` — call `calculateCostBreakdown` and set `summary.costBreakdown`; change `localCompletionRate` from 0-100 to 0-1 ratio (matching `escalationRate` convention)
- [x] T022 [US8] Populate `plannerName` and `implementerName` in `buildSummary` in `src/engine/orchestrator/cost.ts` from the options/parameters
- [x] T023 [P] [US8] Remove dead exports: `setShikiTheme` export in `src/engine/highlight.ts:27-32`, `listDir` export keyword in `src/engine/planners/context.ts:41`, `spawnWithStdin` re-export in `src/engine/planners/base.ts:40`
- [x] T024 [P] [US8] Remove unused props: `exit` from `RouterProps` in `src/router.tsx:36` and `App` passing in `src/app.tsx`; `onOpenOverlay` from `HomeScreenProps` in `src/screens/home.tsx` and `WorkflowScreenProps` in `src/screens/workflow.tsx`
- [x] T025 [US8] Clean up `src/router.tsx`: merge duplicate `import type` from `'./types.js'` (lines 8 and 17); fix `navigate` typing from `data?: any` to proper typed union; fix `data?.summary!` contradictory assertion in `src/hooks/use-router.ts:32`

**Checkpoint**: Zero dead code. Cost breakdown displays correctly. Build compiles clean.

---

## Phase 11: User Story 9 — Workflow Screen Performance (Priority: P2)

**Goal**: Memoize derived data on the workflow screen and bound the highlight cache.

**Independent Test**: Verify sidebar task list and cost data only recompute when inputs change. Verify highlight cache doesn't grow unbounded.

- [x] T026 [P] [US9] Wrap sidebar `taskMap` computation in `useMemo` keyed on `workflow.events` in `src/screens/workflow.tsx:40-52`
- [x] T027 [P] [US9] Wrap `costData` object in `useMemo` keyed on `workflow.localCount` and `workflow.escalatedCount` in `src/screens/workflow.tsx:54-58`
- [x] T028 [P] [US9] Add cache size eviction to `src/engine/highlight.ts:8` — when `cache.size > 500`, delete oldest entries (e.g., delete first 100 entries via iterator)
- [x] T029 [US9] Fix `useMemo` referential stability in `src/ui/picker.tsx:22-38` — move `.filter()` inside the `useMemo` callback and use stable `implementers` prop as dependency instead of the unstable `availableImplementers` array

**Checkpoint**: Workflow screen remains responsive with thousands of events. Highlight cache is bounded.

---

## Phase 12: User Story 10 — DRY Consolidation (Priority: P3)

**Goal**: Consolidate duplicated patterns into shared utilities across subprocess spawning, event emission, test fixtures, provider URLs, and rendering logic.

**Independent Test**: Grep for known duplicate signatures, verify single source of truth for each.

### Subprocess Unification

- [ ] T030 [US10] **DEFERRED** — Create unified `spawnProcess` in `src/utils/process.ts` (high-risk refactor, deferred to separate PR)
- [ ] T031 [US10] **DEFERRED** — Migrate `src/engine/planners/spawn.ts` (depends on T030)
- [ ] T032 [US10] **DEFERRED** — Migrate `src/engine/implementers/shell.ts` (depends on T030)
- [ ] T033 [US10] **DEFERRED** — Refactor `src/engine/planners/claude-code.ts` (depends on T030)

### Implementer Helpers

- [x] T034 [P] [US10] Move `parseNdjsonLine` from `src/engine/planners/opencode.ts:10-33` to `src/engine/output-parsers.ts` as `parseOpencodeLine`, normalize return type to match `ParsedLine`
- [x] T035 [US10] Extract `createGenEventEmitter(onEvent, model, file)` factory and `processImplementerOutput(text, task, projectDir, emitGenEvent)` helper in `src/engine/implementer.ts`
- [x] T036 [US10] Add diff computation to shell implementer — use `processImplementerOutput` from T035 so shell backend emits `{ linesAdded, linesRemoved, diff }` in done events (matching OpenAI backend behavior)

### Constants & Configuration

- [x] T037 [P] [US10] Export `DEFAULT_BASES` from `src/engine/providers.ts` and import in `src/cli.ts` (replace `providerBases` at line 97-100) and `src/config.ts` (replace hardcoded URLs)
- [x] T038 [P] [US10] Export `ALL_SCREENS` from `src/types.ts`, import in `src/commands.ts:3` and `src/shortcuts.ts:3` (replace duplicated const)
- [x] T039 [US10] Extract shared `renderApp(appElement, fullscreen: boolean)` helper in `src/cli.ts` — replace duplicated fullscreen rendering blocks in start (~line 182-192) and resume (~line 333-343)

### Test Fixtures

- [x] T040 [US10] Create `tests/helpers/fixtures.ts` with shared `makeConfig(overrides?)`, `makeTask(overrides?)`, `makeUsage(overrides?)`, and `defaultContext` exports
- [x] T041 [US10] Migrate all test files to use shared fixtures from `tests/helpers/fixtures.ts`: `tests/agent-implementer.test.ts`, `tests/formatter.test.ts`, `tests/implementer.test.ts`, `tests/orchestrator.test.ts`, `tests/providers.test.ts`, `tests/shell-implementer.test.ts`, `tests/summary.test.ts`, `tests/openai-stream.test.ts`

**Checkpoint**: Each duplicated pattern has exactly one source of truth. Grep confirms no duplicate signatures remain.

---

## Phase 13: User Story 11 — Function Signature Clarity (Priority: P3)

**Goal**: Convert all functions with >3 positional parameters to options objects.

**Independent Test**: Verify all identified functions accept options objects. Verify no `undefined` holes at call sites. Build compiles clean.

- [x] T042 [US11] Define `RunWorkflowOptions` interface in `src/types.ts` and convert `runWorkflow` in `src/engine/orchestrator/index.ts:21-28` from 6 positional params to options object
- [x] T043 [US11] Define `HandleRetryOptions` interface and convert `handleRetryAndEscalation` in `src/engine/orchestrator/task-runner.ts:195-204` from 8 positional params to options object
- [x] T044 [US11] Define `BuildSummaryOptions` interface and convert `buildSummary` in `src/engine/orchestrator/cost.ts:50` from 6 positional params to options object (trailing optionals become named fields)
- [x] T045 [US11] Convert `transitionAndEmit` in `src/engine/orchestrator/planning.ts:14-29` from 6 params to options object
- [x] T046 [US11] Update all call sites for T042-T045: `src/engine/orchestrator/index.ts`, `src/engine/orchestrator/task-loop.ts`, `src/engine/orchestrator/planning.ts`, `src/hooks/use-workflow.ts`

**Checkpoint**: No function in the orchestrator has more than 3 positional parameters. All call sites compile clean.

---

## Phase 14: User Story 12 — React Pattern Improvements (Priority: P3)

**Goal**: Fix React anti-patterns: chained effects, useEffect for sync reads, ineffective memoization, duplicate imports, and minor code quality issues.

**Independent Test**: Verify picker auto-selects in single render cycle. Verify sessions available on first render. Build compiles clean.

- [x] T047 [US12] Refactor `src/ui/picker.tsx` — replace 5 chained `useEffect` hooks (lines 40-87) with eager `useState` initializers for `step` and `selectedPlanner` + a single `useEffect` for side effects (`onComplete`/`onError`). Remove `errorFired`/`completeFired` guard refs.
- [x] T048 [US12] Convert `src/hooks/use-sessions.ts` — replace `useEffect` + `useState` with `useMemo` for the synchronous `listSessions` call. Remove `loading` state. Add `revision` counter for `saveSession` to trigger re-derivation.
- [x] T049 [P] [US12] Consolidate duplicate imports across codebase: merge duplicate `import type` from `'./types.js'` in `src/router.tsx:8,17`; merge duplicate imports from `'../../utils/process.js'` in `src/engine/planners/spawn.ts:2-3`
- [x] T050 [P] [US12] Collapse duplicated lint branch in `src/engine/validator.ts:93-101` — extract linter args into a variable and use a single validation block
- [x] T051 [P] [US12] Extend detection timeout in `src/engine/detection.ts:78-80` to wrap both `fetch()` and `res.json()` in `withTimeout`, not just the fetch headers

**Checkpoint**: Picker auto-selects in one render cycle. Sessions hook has no loading flash. All imports consolidated.

---

## Phase 15: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup across all stories.

- [x] T052 Run full test suite (`npm test`), fix any regressions introduced by changes
- [x] T053 Run build (`npm run build`), verify clean TypeScript compilation with zero errors
- [x] T054 Run quickstart.md verification: spot-check DRY consolidation with grep (provider URLs, test fixtures, `emitGenEvent`, `ALL_SCREENS`), verify `src/ui/summary.tsx` is deleted, verify no functions have >3 positional params

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Empty — no initialization needed
- **Foundational (Phase 2)**: Empty — no blocking prerequisites
- **User Stories (Phases 3-14)**: All independent of each other — can proceed in any order
- **Polish (Phase 15)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1** (Patch Integrity): No dependencies — standalone fix in `apply.ts`
- **US2** (Workflow Continuity): No dependencies — standalone fixes in hooks
- **US3** (Retry Prompt Quality): No dependencies — standalone fixes in formatter + task-runner
- **US4** (CLI Flags): No dependencies — standalone fix in `cli.ts`
- **US5** (Subprocess Safety): No dependencies — standalone fixes in `process.ts`
- **US6** (Dependency Resolution): No dependencies — standalone fix in `parser.ts`
- **US7** (Planner Consistency): No dependencies — standalone fixes in planner backends
- **US8** (Dead Code): No dependencies — but T021-T022 touch `cost.ts` which T044 also touches. If both are done, T044 should come after T021-T022.
- **US9** (Performance): No dependencies — standalone fixes in UI components
- **US10** (DRY Consolidation): T030 (spawnProcess) should come before T031-T033 (migrations). T035 should come before T036. T040 should come before T041.
- **US11** (Function Signatures): T042-T045 define interfaces, T046 updates call sites. If US8 T021-T022 modified `buildSummary`, T044 should follow.
- **US12** (React Patterns): No dependencies — standalone fixes in UI/hooks

### Within Each User Story

- Tasks marked [P] can run in parallel
- Tasks without [P] must run sequentially within their story
- Run tests after completing each story's tasks

### Cross-Story Dependencies

- **US8 T021-T022 → US11 T044**: Both touch `buildSummary` in `cost.ts`. Wire costBreakdown first, then convert to options object.
- **US10 T030 → US10 T031-T033**: Create unified utility first, then migrate consumers one at a time.
- **US10 T035 → US10 T036**: Create shared helpers first, then use them in shell implementer.
- **US10 T040 → US10 T041**: Create shared fixtures first, then migrate test files.

---

## Parallel Opportunities

### Within P1 Stories (Phases 3-8)

All six P1 stories can run in parallel — they touch completely different files:

```
Parallel batch 1 (all independent):
  US1: apply.ts
  US2: use-workflow.ts + use-input-mode.ts
  US3: formatter.ts + task-runner.ts
  US4: cli.ts
  US5: process.ts
  US6: parser.ts
```

### Within P2 Stories (Phases 9-11)

All three P2 stories can run in parallel:

```
Parallel batch 2 (all independent):
  US7: agent-sdk.ts + shell.ts + aider.ts
  US8: summary.tsx + cost.ts + highlight.ts + base.ts + context.ts + router.tsx + screens
  US9: workflow.tsx + highlight.ts + picker.tsx
```

Note: US8 and US9 both touch `highlight.ts` — US8 removes `setShikiTheme`, US9 adds cache eviction. These are non-overlapping changes and can proceed in parallel.

### Within P3 Stories (Phases 12-14)

```
Parallel batch 3 (partially independent):
  US10: T034, T037, T038 can run in parallel (different files)
  US11: T042-T045 can run in parallel (different files), T046 depends on all
  US12: T047, T048, T049, T050, T051 can all run in parallel (different files)
```

---

## Implementation Strategy

### MVP First (P1 Stories Only)

1. Complete Phases 3-8: All six P1 correctness bug stories
2. **STOP and VALIDATE**: Run `npm test` and `npm run build`
3. At this point: zero data corruption, zero hangs, zero leaks, CLI flags work, dependencies resolve

### Incremental Delivery

1. **P1 Correctness** (Phases 3-8) → All bugs fixed → Test + Build
2. **P2 Consistency** (Phases 9-11) → Dead code gone, performance fixed, backends consistent → Test + Build
3. **P3 Quality** (Phases 12-14) → DRY consolidated, signatures clean, React patterns fixed → Test + Build
4. **Polish** (Phase 15) → Full verification → Ready for merge

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group within a story
- Stop at any checkpoint to validate story independently
- The 6 P1 stories are the MVP — all other stories are quality improvements that can be deferred
- Total: 54 tasks across 12 user stories + verification
