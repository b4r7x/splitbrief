# Tasks: Audit Remediation

**Input**: Design documents from `/specs/018-audit-remediation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Verify baseline before making any changes

- [x] T001 Verify all tests pass on current branch by running `npm test` and `npx tsc --noEmit`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Not applicable for this refactoring — no cross-cutting infrastructure needed. Each user story modifies existing files directly.

**⚠️ Note**: US2 creates new module files that US3 depends on. US3 exports shared types that US4 references. Execute stories in priority order (P1→P6) for the engine tracks. US5 (React/UI) can run in parallel with engine stories.

---

## Phase 3: User Story 1 - Critical Bug Fixes (Priority: P1) 🎯 MVP

**Goal**: Fix the 5 critical bugs that affect workflow state, streaming, provider detection, and subprocess cleanup.

**Independent Test**: Each bug fix can be verified by a unit test. Run `npm test` after all fixes.

### Implementation for User Story 1

- [x] T002 [P] [US1] Fix missing `setTrackedState(state)` call on first-try success path in src/engine/orchestrator/task-loop.ts — add after state assignment at the `continue` before the retry/escalation branch, matching the pattern on lines 124 and 150
- [x] T003 [P] [US1] Fix Ollama URL construction in src/engine/providers.ts — strip `/v1` suffix from `apiBase` before constructing native API URL (`/api/show`); derive fallback from `DEFAULT_BASES.ollama.baseURL` instead of hardcoded string; also replace `'no-key'` fallback with empty string `''`
- [x] T004 [P] [US1] Convert absolute timeout to idle timeout with typed error in src/engine/openai-stream.ts — reset timer on each received chunk using clearTimeout+setTimeout pattern; extract `STREAM_TIMEOUT_MS = 60_000` constant; attach `isTimeout: true` property to timeout error via `Object.assign`; update catch block to check `'isTimeout' in err` instead of string matching on `err.message`
- [x] T005 [P] [US1] Fix timer leak on ENOENT in src/utils/process.ts — clear timeout timer in the `error` event handler of `runCommand` before calling `reject(err)` by hoisting the timer variable declaration above the error handler registration
- [x] T006 [US1] Add tests for all 4 bug fixes: test idle timeout resets on chunks (mock stream), test timer cleared on spawn error, test `setTrackedState` called on success path (verify via mock), test Ollama URL strips `/v1` — add to appropriate test files in tests/

**Checkpoint**: All 5 critical bugs fixed. Run `npm test` to verify no regressions.

---

## Phase 4: User Story 2 - Architecture Remediation (Priority: P2)

**Goal**: Break the circular import, split oversized files, fix cost calculation defaults, and update CLAUDE.md.

**Independent Test**: Run `npx madge --circular --extensions ts,tsx src/` for zero cycles. Check `wc -l src/engine/planners/base.ts` under 200 lines. Diff CLAUDE.md against `find src/`.

### Implementation for User Story 2

- [x] T007 [US2] Create src/engine/orchestrator/helpers.ts — move `refreshCurrentCode` function from task-loop.ts into this new module; update import in src/engine/orchestrator/task-runner.ts to import from `./helpers.js`; update import in src/engine/orchestrator/task-loop.ts to import from `./helpers.js`; add re-export in src/engine/orchestrator/index.ts if needed
- [x] T008 [US2] Create src/engine/planners/spawn.ts — move `spawnWithStdin` function and `InvokeResult` type from src/engine/planners/base.ts into this new module; update base.ts to import from `./spawn.js`; ensure all type exports are preserved
- [x] T009 [US2] Create src/engine/planners/context.ts — move `buildProjectContextMarkdown` and `listDir` functions from src/engine/planners/base.ts into this new module; update base.ts to import from `./context.js`; add max depth parameter to `listDir` (default 4) per research R3
- [x] T010 [US2] Update all 6 planner backend imports: change imports of `spawnWithStdin` from `./base.js` to `./spawn.js` in src/engine/planners/claude-code.ts, codex.ts, opencode.ts, aider.ts, agent-sdk.ts, shell.ts
- [x] T011 [P] [US2] Fix `buildSummary` in src/engine/orchestrator/cost.ts — add `plannerTool?: string` and `implementerProvider?: string` parameters; forward to `estimateCostSavings`; update all call sites in src/engine/orchestrator/index.ts to pass `config.planner.tool` and `config.implementer.provider`
- [x] T012 [P] [US2] Update CLAUDE.md project structure section — remove 6 phantom files (helpers.ts as documented, layout.tsx, prompt.tsx, user-input.tsx, question-prompt.tsx, hooks/index.ts); add all 25+ undocumented files (orchestrator/events.ts, output-parsers.ts, skills.ts, router.tsx, screens/, shortcuts.ts, commands.ts, all hooks, all new UI files, utils/diff.ts, utils/sessions.ts, utils/version.ts, and the 3 new files from this feature: orchestrator/helpers.ts, planners/spawn.ts, planners/context.ts)
- [x] T013 [US2] Verify architecture: run `npx madge --circular --extensions ts,tsx src/` and confirm zero circular dependencies; check `wc -l src/engine/planners/base.ts` is under 200 lines

**Checkpoint**: Circular import broken. base.ts split into 3 focused modules. CLAUDE.md matches filesystem. Run `npm test`.

---

## Phase 5: User Story 3 - DRY Violation Cleanup (Priority: P3)

**Goal**: Consolidate duplicated types, parsing logic, and prompt patterns into single canonical locations.

**Independent Test**: Grep for inline type patterns to verify zero remaining duplicates.

### Implementation for User Story 3

- [x] T014 [P] [US3] Export `ImplementerResult` type from src/engine/implementer.ts — replace all inline `{ success: boolean; output: string; error?: string; usage?: { promptTokens: number; completionTokens: number } }` types in src/engine/implementers/agent.ts (4 occurrences) and src/engine/implementers/shell.ts (3 occurrences) with the imported type
- [x] T015 [P] [US3] Import `InvokeResult` from src/engine/planners/spawn.ts in all 6 planner backends — replace inline `{ text: string; usage: { inputTokens: number; outputTokens: number } | null }` return types in claude-code.ts, codex.ts, opencode.ts, aider.ts, agent-sdk.ts, shell.ts
- [x] T016 [P] [US3] Deduplicate aider.ts: remove `parseKTokens` and `parseTokenUsage` (duplicate regex+logic from output-parsers.ts); use `parseTextLine` from src/engine/output-parsers.ts instead; replace manual args in `invokeEscalate` with call to existing `aiderAskArgs()` helper
- [x] T017 [P] [US3] Create shared `buildFullPrompt(task, context?)` and `buildFullRetryPrompt(task, error, attempt, context?)` in src/engine/spec/formatter.ts — replace 3 inline `SYSTEM_PREAMBLE + '\n\n' + formatTaskPrompt(...)` concatenations in src/engine/implementers/agent.ts and src/engine/implementers/shell.ts
- [x] T018 [P] [US3] Merge duplicate import lines in src/engine/planners/claude-code.ts — combine `import type { PlannerBackend } from './types.js'` and `import type { EscalationResult } from './types.js'` into a single import statement

**Checkpoint**: Zero inline type duplicates remain. Grep `success: boolean.*output: string.*error\?` in implementers/ returns 0. Grep `text: string.*usage:.*inputTokens` in planners/ returns 0. Run `npm test`.

---

## Phase 6: User Story 4 - Function Signature Refactoring (Priority: P4)

**Goal**: Refactor all functions with >3 positional parameters to use options objects.

**Independent Test**: Grep exported function signatures in `src/engine/` and verify none has >3 comma-separated params.

### Implementation for User Story 4

- [x] T019 [P] [US4] Refactor src/engine/openai-stream.ts — create `StreamCompletionOptions` interface (`temperature`, `onProgress`, `config`, `maxTokens?`); update `streamCompletion` to accept `(client, model, messages, opts)` (4 params); update call site in implementer.ts
- [x] T020 [P] [US4] Refactor src/engine/implementers/agent.ts and src/engine/implementers/shell.ts — create `SpawnAgentOptions` for `spawnAgent` (7→opts), `RunAgentOptions` for `runAgentImplementer` (6→opts), `SpawnShellOptions` for `spawnShellImplementer` (6→opts); update all internal call sites
- [x] T021 [P] [US4] Refactor src/engine/spec/formatter.ts and src/engine/validator.ts — simplify `computeTokenBudget`: remove 2 always-empty params (`typeDefs`, `implSteps`), keep only `system`, `taskBody`, `contextLength`; update call site at formatter.ts:162; create inline options for `runValidationStep` (5→opts)
- [x] T022 [P] [US4] Refactor src/engine/planners/agent-sdk.ts and src/engine/planners/shell.ts — create options for `runQuery` (6→opts) and `spawnShellCommand` (6→opts); update internal call sites
- [x] T023 [US4] Refactor src/engine/implementer.ts — create options for `runOpenAIImplementer` (7→opts) and `retryTask` (8→opts); update call sites in orchestrator/task-loop.ts and task-runner.ts (depends on T019 for updated streamCompletion signature)
- [x] T024 [P] [US4] Refactor src/engine/orchestrator/planning.ts — create `PlanningPhaseOptions` for `runPlanningPhase` (7→opts) and `ApprovalLoopOptions` for `runApprovalLoop` (6→opts); update call site in index.ts
- [x] T025 [P] [US4] Refactor src/engine/orchestrator/task-runner.ts — create `ValidateCommitOptions` for `validateCommitAndAdvance` (10→opts); update call sites in task-loop.ts and within task-runner.ts
- [x] T026 [US4] Refactor src/engine/orchestrator/task-loop.ts — remove unused params `feature` and `startTime`; create `RunTaskLoopOptions` for remaining 7 params; create inline options for `buildAndRecordUsage` (8→opts); update call site in index.ts

**Checkpoint**: No exported function in `src/engine/` has >3 positional parameters. Run `npm test` and `npx tsc --noEmit`.

---

## Phase 7: User Story 5 - React/UI Quality Fixes (Priority: P5)

**Goal**: Fix picker duplicate callbacks, markdown language detection, theme prop drilling, and memoization.

**Independent Test**: Picker fires `onComplete` exactly once. Code blocks render with correct language highlighting. No unnecessary `getTheme()` calls.

**Note**: This phase can run in parallel with Phases 4-6 (engine changes) since UI files are independent of engine refactoring.

### Implementation for User Story 5

- [x] T027 [P] [US5] Fix src/ui/picker.tsx — add `completeFired` ref guard to both `useEffect`s calling `onComplete` (lines 55-58 and 72-76); wrap `allModels` array computation in `useMemo` with `[availableImplementers]` dependency; extract hardcoded `'ollama'` + `'qwen2.5-coder:7b'` fallback to named constants
- [x] T028 [P] [US5] Fix src/ui/markdown.tsx — in `parseBlocks`, preserve the original `langHint` string from code fence instead of hardcoding `'typescript'`; pass `codeLang` through to `HighlightedCode` component; in `HighlightedCode`, use the received language hint for Shiki highlighting (fall back to `'typescript'` only if hint is empty)
- [x] T029 [P] [US5] Refactor src/ui/event-card.tsx — call `getTheme()` once in the main `EventCard` component; pass `theme` (or the specific colors needed) as props to all 8 sub-components (`Spinner`, `PlannerCard`, `ImplementerCard`, `ValidateCard`, `CommitCard`, `SkipCard`, `QuestionCard`, `EscalationCard`); remove all internal `getTheme()` calls from sub-components
- [x] T030 [P] [US5] Decompose src/ui/summary.tsx — extract 5 section components from `SummaryView`: `OverviewSection`, `TasksSection`, `TokenUsageSection`, `CostSection`, `TaskBreakdownSection`; each receives relevant data slice + theme as props; `SummaryView` becomes a ~40-line orchestrator; call `getTheme()` once at top level
- [x] T031 [P] [US5] Fix src/hooks/use-skills.ts — wrap `selectedMetas` computation (`available.filter(...)`) in `useMemo` with `[available, selected]` dependency array to return stable array reference

**Checkpoint**: Picker fires `onComplete` once per selection. Markdown renders ` ```bash ` with bash highlighting. `getTheme()` called once per component tree. Run `npm test`.

---

## Phase 8: User Story 6 - Dead Code, Magic Values, and Minor Cleanup (Priority: P6)

**Goal**: Remove unused code, extract magic values to constants, fix test helpers, and standardize style.

**Independent Test**: Grep for removed artifacts returns 0 hits. `npx tsc --noEmit` passes.

### Implementation for User Story 6

- [x] T032 [P] [US6] Remove unused `auto` property from `UseWorkflowOptions` interface in src/hooks/use-workflow.ts; remove from destructuring in `useWorkflow` function; update `WorkflowScreen` props and callers to stop passing `auto`
- [x] T033 [P] [US6] Extract named constants: `DETECTION_TIMEOUT_MS = 5000` in src/engine/detection.ts (replace 3 occurrences); `SEARCH_REPLACE_THRESHOLD = 200` in src/engine/apply.ts (replace 1 occurrence)
- [x] T034 [P] [US6] Planner interface cleanup: make `onPhase` optional (`onPhase?: (phase: string) => void`) in src/engine/planners/types.ts; extract `MAX_CLARIFICATION_QUESTIONS = 5` and remove no-op `onPhase: (_phase) => {}` stub in src/engine/orchestrator/planning.ts
- [x] T035 [P] [US6] Planner backend cleanup: extract `DEFAULT_MODEL = 'claude-sonnet-4-6'` at module scope in src/engine/planners/agent-sdk.ts (replace 3 occurrences); move `ALLOWED_TOOLS` array from inside `createAgentSdkPlanner` to module scope
- [x] T036 [P] [US6] Spec/validator cleanup: remove redundant `parseDependsOn` function in src/engine/spec/parser.ts (use already-parsed array from frontmatter directly); remove redundant `relative(projectDir, join(projectDir, taskFile))` roundtrip in src/engine/validator.ts:30 (replace with just `taskFile`; remove unused `relative` import)
- [x] T037 [P] [US6] Fix src/types.ts: move `ALL_SCREENS` runtime value to src/commands.ts (or inline at usage sites in commands.ts and shortcuts.ts); replace inline `import('./engine/question-parser.js').ClarificationQuestion` with a top-level `import type` statement
- [x] T038 [P] [US6] Fix test helpers: add `typeDefs: ''` and `implSteps: []` to `makeTask` in tests/orchestrator.test.ts and tests/implementer.test.ts; remove duplicate `describe('estimateTokens (token budgeting)')` block (lines 268-276) in tests/formatter.test.ts
- [x] T039 [P] [US6] Fix src/ui/help-overlay.tsx: remove unused `onClose` prop from component interface; replace hardcoded slash command list with data from src/commands.ts; extract `LABEL_COL_WIDTH = 14` constant (shared with slash-suggestions.tsx)
- [x] T040 [P] [US6] Standardize quote style to single quotes in src/router.tsx, src/screens/home.tsx, and src/ui/input-bar.tsx — change all double-quoted import strings and string literals to single quotes to match project convention

**Checkpoint**: Zero unused params, zero magic numbers, zero duplicate tests, consistent quotes. Run `npm test` and `npx tsc --noEmit`.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across all user stories

- [x] T041 Run full test suite (`npm test`) and verify zero failures across all test files
- [x] T042 Run `npx madge --circular --extensions ts,tsx src/` and verify zero circular dependencies
- [x] T043 Execute all verification steps from specs/018-audit-remediation/quickstart.md (file sizes, parameter counts, DRY checks, CLAUDE.md accuracy, visual smoke test)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 3)**: No dependencies — can start after Setup
- **US2 (Phase 4)**: No dependencies on US1 — can start after Setup (different files)
- **US3 (Phase 5)**: Depends on US2 (T008 creates spawn.ts with InvokeResult; T010 updates planner imports)
- **US4 (Phase 6)**: Depends on US3 (shared types must be stable before refactoring signatures)
- **US5 (Phase 7)**: **Independent of all engine stories** — can run in parallel with US2-US4
- **US6 (Phase 8)**: Best after US4 to avoid file conflicts (both modify planning.ts, agent-sdk.ts, validator.ts)
- **Polish (Phase 9)**: After all stories complete

### Parallel Tracks

```text
Track A (Engine):  US1 → US2 → US3 → US4 → US6
Track B (UI):      US5 (independent, anytime after Setup)
                          ↘ US6 UI tasks (T039, T040) can start after US5
Final:             Polish (after both tracks complete)
```

### Within-Phase Dependencies

- **Phase 4 (US2)**: T007→T008→T009→T010 (sequential: create files, move code, update imports); T011 and T012 are [P] (independent)
- **Phase 6 (US4)**: T019 before T023 (streamCompletion signature needed by implementer.ts refactor); all other tasks are [P]

### Parallel Opportunities

- **Phase 3 (US1)**: All 4 bug fixes (T002-T005) in different files — fully parallel
- **Phase 5 (US3)**: All 5 tasks in different files — fully parallel
- **Phase 6 (US4)**: T019-T022 + T024-T026 are [P] (7 of 8 tasks parallelizable)
- **Phase 7 (US5)**: All 5 tasks in different files — fully parallel
- **Phase 8 (US6)**: All 9 tasks in different files — fully parallel
- **Cross-phase**: US5 (Phase 7) can run entirely in parallel with US2-US4 (Phases 4-6)

---

## Parallel Example: User Story 1

```bash
# Launch all 4 bug fixes together (different files):
Task: "Fix setTrackedState in src/engine/orchestrator/task-loop.ts"
Task: "Fix Ollama URL in src/engine/providers.ts"
Task: "Fix idle timeout in src/engine/openai-stream.ts"
Task: "Fix timer leak in src/utils/process.ts"
```

## Parallel Example: User Story 5 alongside Engine Stories

```bash
# These can all run simultaneously since UI and engine files don't overlap:
Track A: "Create spawn.ts from base.ts" (US2 engine)
Track B: "Fix picker.tsx completeFired guard" (US5 UI)
Track C: "Fix markdown.tsx language hints" (US5 UI)
Track D: "Decompose summary.tsx" (US5 UI)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (verify baseline)
2. Complete Phase 3: US1 — Critical Bug Fixes
3. **STOP and VALIDATE**: All 5 bugs fixed, tests pass
4. This alone delivers significant value (correctness fixes)

### Incremental Delivery

1. Setup → US1 (Critical Bugs) → Test ✓ **(MVP)**
2. → US2 (Architecture) → Test ✓
3. → US3 (DRY) → Test ✓
4. → US4 (Signatures) → Test ✓
5. → US5 (React/UI) → Test ✓ *(can be done in parallel with steps 2-4)*
6. → US6 (Cleanup) → Test ✓
7. → Polish → Final verification ✓

### Parallel Execution Strategy

With agent parallelism:

1. Complete Setup
2. Launch US1 (engine bugs) + US5 (UI fixes) in parallel
3. After US1: Launch US2 (architecture)
4. After US2: Launch US3 (DRY)
5. After US3: Launch US4 (signatures)
6. After US4 + US5: Launch US6 (cleanup)
7. Polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US5 (React/UI) is fully independent of engine stories — exploit this parallelism
- Total: 43 tasks across 6 user stories + setup + polish
