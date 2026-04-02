# Tasks: Engine Code Quality to 5/5

**Input**: Design documents from `/specs/017-engine-code-quality/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. Sequenced per plan.md: leaf utilities → planner backends → orchestrator → cross-cutting.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Verify baseline and fix pre-existing issues before refactoring begins

- [x] T001 Verify baseline — run `npx tsc --noEmit` and `npx tsx --test tests/orchestrator.test.ts` to document current state
- [x] T002 Fix pre-existing orchestrator test failure "accepts a savedState parameter (6th argument)" in tests/orchestrator.test.ts — update test to match current runWorkflow signature from 016-engine-srp-refactor

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types and utilities that multiple user stories depend on

- [x] T003 [P] Add `isENOENT(err: unknown): boolean` utility to src/utils/process.ts — replaces 8 inline ENOENT checks across the codebase
- [x] T004 [P] Add `model?: string` to `Config.planner` type and add `BuildSummaryState = Pick<WorkflowState, 'tasks' | 'completedTasks' | 'escalatedTasks' | 'skippedTasks' | 'failedTasks' | 'tokenUsage'>` type in src/types.ts
- [x] T005 [P] Remove unused `ProjectContext` import from src/engine/planners/types.ts

**Checkpoint**: Foundation ready — all user stories can now proceed

---

## Phase 3: User Story 1 — Eliminate Cross-File Output Parser Duplication (Priority: P1) 🎯 MVP

**Goal**: All output format parsers (text, JSONL, stream-json) exist in a single shared module. No duplicated parser code remains.

**Independent Test**: `npx tsc --noEmit` passes. Grep for `function parseTextLine`, `function parseJsonlLine`, `function parseCodexLine`, `function getLineParser` — each exists in exactly one file. Run `npx tsx --test tests/implementer.test.ts tests/shell-implementer.test.ts tests/planners.test.ts`.

### Implementation for User Story 1

- [x] T006 [US1] Create src/engine/output-parsers.ts with `parseTextLine`, `parseJsonlLine`, `getLineParser`, and `accumulateUsage` — extract from src/engine/planners/shell.ts as the canonical source; include the `ParsedLine` type; `accumulateUsage` replaces the 7-line inline pattern duplicated 5+ times
- [x] T007 [US1] Migrate src/engine/planners/shell.ts — replace inline `parseTextLine`, `parseJsonlLine`, `getLineParser` with imports from `../output-parsers.js`; replace inline usage accumulation with `accumulateUsage`
- [x] T008 [P] [US1] Migrate src/engine/planners/codex.ts — replace `parseCodexLine` with `parseJsonlLine` import from `../output-parsers.js`; remove the inline parser function
- [x] T009 [US1] Migrate src/engine/implementers/shell.ts — replace inline `parseTextLine`, `parseJsonlLine`, `parseStreamJsonLine`, `getLineParser` with imports from `../output-parsers.js`; replace inline usage accumulation with `accumulateUsage`

**Checkpoint**: All parsers consolidated. `npx tsc --noEmit` clean. No parser function duplicated.

---

## Phase 4: User Story 2 — Eliminate Spawn Boilerplate Duplication (Priority: P1)

**Goal**: Subprocess lifecycle (spawn, stdin pipe, line buffering, ENOENT handling, exit code classification) handled by shared utilities. Each planner's spawn function reduced to ~10-15 lines of glue.

**Independent Test**: `npx tsc --noEmit` passes. Each planner's spawn function is under 20 lines. `getVersion` implementations use the factory. Run `npx tsx --test tests/planners.test.ts tests/planner-version.test.ts tests/planner-detection.test.ts`.

### Implementation for User Story 2

- [x] T010 [US2] Add `spawnWithStdin` utility to src/engine/planners/base.ts — accepts `{ command, args, cwd, stdin?, onLine, onStderr?, notFoundMessage }`, returns `Promise<SpawnResult>` with `{ collectedText, stderrOutput, code }`; handles ENOENT via `isENOENT`, exit code 127, line buffering, activeProcesses tracking
- [x] T011 [US2] Add `createGetVersion(command, args?)` and `createIsAvailable(command, opts?)` factories to src/engine/planners/base.ts — use static `runCommand` import (not dynamic); unexport `listDir` and `buildProjectContext`
- [x] T012 [US2] Migrate src/engine/planners/codex.ts — replace `spawnCodex` body with `spawnWithStdin` call; replace `getVersion`/`isAvailable` with factories; remove redundant dynamic `import()` of `runCommand`
- [x] T013 [P] [US2] Migrate src/engine/planners/opencode.ts — same pattern as codex; also remove dead `cost` field from `StepFinishUsage` interface
- [x] T014 [P] [US2] Migrate src/engine/planners/aider.ts — same pattern as codex
- [x] T015 [US2] Migrate src/engine/planners/shell.ts — replace `spawnShellCommand` body with `spawnWithStdin`; rename `LOCAL_PRICING` to `SHELL_PRICING`
- [x] T016 [US2] Migrate src/engine/planners/claude-code.ts — rename `spawnClaudeEscalator` to `spawnClaudeWithStdin`; replace body with `spawnWithStdin`; consolidate double `proc.on('close')` handler into one; replace inline ENOENT checks with `isENOENT`
- [x] T017 [US2] Migrate src/engine/orchestrator/final-review.ts — replace hand-rolled Promise spawn wrapper with `spawnWithStdin`; add stderr handling (capture and include in error messages); eliminate internal stream-parse duplication

**Checkpoint**: All planner spawn functions under 20 lines. `getVersion`/`isAvailable` use factories. ENOENT handled by `isENOENT`. `npx tsc --noEmit` clean.

---

## Phase 5: User Story 3 — Decompose God Functions (Priority: P1)

**Goal**: No function in the orchestrator exceeds 30 lines. Retry cascade is split into named phases. Validator uses a shared step helper. Formatter shares section assembly.

**Independent Test**: `npx tsc --noEmit` passes. `npx tsx --test tests/orchestrator.test.ts tests/formatter.test.ts tests/validator.test.ts tests/summary.test.ts`. No function >40 lines in modified files.

### Implementation for User Story 3

- [x] T018 [US3] Extract `refreshCurrentCode(task, projectDir)` helper (reads file into `task.currentCode`) — used 3 times across src/engine/orchestrator/task-runner.ts and task-loop.ts; place in task-loop.ts or a shared orchestrator utility
- [x] T019 [US3] Extract `buildAndRecordUsage(task, method, tokensBefore, state, projectDir)` helper from `runTaskLoop` in src/engine/orchestrator/task-loop.ts — replaces 4 duplicated `TaskTokenUsage` construction + push + emit blocks; remove unused `buildSummary` import
- [x] T020 [US3] Decompose `runTaskLoop` in src/engine/orchestrator/task-loop.ts using T018/T019 helpers — loop body under 30 lines; remove bare `{ }` block scope; rename `retryResult2` to `validationRetryResult`
- [x] T021 [US3] Decompose `handleRetryAndEscalation` in src/engine/orchestrator/task-runner.ts into `runLocalRetries`, `runTier1Hint`, `runTier2Full` + thin coordinator under 25 lines; each tier function encapsulates its implement→validate→commit pattern
- [x] T022 [US3] Extract `runValidationStep(stage, cmd, args, cwd, errorSourcePreference)` from `validateTask` in src/engine/validator.ts — replaces 3 duplicated try/catch blocks (typecheck, eslint, biome); use `isENOENT` from utils/process.ts; reduce function to under 50 lines
- [x] T023 [US3] Extract `buildTaskSections(task)` from `formatTaskPrompt` and `formatRetryPrompt` in src/engine/spec/formatter.ts — shared section assembly (title, action, file, description, signature, typeDefs, implSteps, tests, constraints); both formatters under 40 lines
- [x] T024 [US3] Update tests/orchestrator.test.ts for decomposed function signatures; update tests/formatter.test.ts if import paths changed; verify all pass

**Checkpoint**: All god functions decomposed. Max function size ≤40 lines. All orchestrator and formatter tests pass.

---

## Phase 6: User Story 4 — Decompose helpers.ts Grab-Bag (Priority: P2)

**Goal**: `helpers.ts` deleted. Functions relocated to concern-specific modules. All imports updated.

**Independent Test**: `npx tsc --noEmit` passes. `helpers.ts` does not exist. Grep for `from './helpers.js'` returns zero results. `npx tsx --test tests/orchestrator.test.ts`.

### Implementation for User Story 4

- [x] T025 [US4] Create src/engine/orchestrator/events.ts — move `emit`, `emitValidationStart`, `emitValidationResult`, `allValidationsPassed` from helpers.ts; fix `emitValidationResult` to call `allValidationsPassed` instead of reimplementing the passed-check logic
- [x] T026 [US4] Move `supportsConversational` from helpers.ts to src/engine/planners/base.ts (planner concern); move `persistClarifications` to src/engine/spec/parser.ts or new utility
- [x] T027 [US4] Inline `buildContext` into src/engine/orchestrator/planning.ts (only caller); inline `hasDependencyFailed` into src/engine/orchestrator/task-loop.ts (only caller, 4-line predicate)
- [x] T028 [US4] Update all imports: replace `from './helpers.js'` with new locations in task-runner.ts, task-loop.ts, planning.ts, index.ts; delete src/engine/orchestrator/helpers.ts
- [x] T029 [US4] Verify: `npx tsc --noEmit` clean; grep confirms zero references to helpers.js; run tests/orchestrator.test.ts

**Checkpoint**: helpers.ts eliminated. All functions in concern-specific homes. No broken imports.

---

## Phase 7: User Story 5 — Remove Dead Code and Fix Naming (Priority: P2)

**Goal**: Zero dead exports, unused imports, or unused variables in engine files. All misleading names corrected.

**Independent Test**: `npx tsc --noEmit` passes. Grep for each removed symbol returns zero results. Grep for old names returns zero results.

### Implementation for User Story 5

- [x] T030 [P] [US5] Remove `validateProviderCredentials` function from src/engine/providers.ts
- [x] T031 [P] [US5] Fix dead `stderrOutput` in src/engine/implementers/agent.ts — include stderr output in error messages on non-zero exit (matching the pattern in shell.ts)
- [x] T032 [P] [US5] Remove unused `BREAKPOINTS.SMALL` and `BREAKPOINTS.LARGE` constants from src/hooks/use-terminal-size.ts
- [x] T033 [US5] Rename `WRITE_TOOLS` to `ALLOWED_TOOLS` in src/engine/planners/agent-sdk.ts; replace `(config.planner as any).model` with typed access using the new `model?` field from T004

**Checkpoint**: Zero dead code. All names accurate. `npx tsc --noEmit` clean.

---

## Phase 8: User Story 6 — Fix Internal Duplication Within Files (Priority: P2)

**Goal**: No function contains a duplicated block of 4+ lines. Each piece of logic exists exactly once within its file.

**Independent Test**: `npx tsc --noEmit` passes. Manual inspection: no repeated blocks >3 lines within any single function. Run `npx tsx --test tests/implementer.test.ts tests/orchestrator.test.ts`.

### Implementation for User Story 6

- [x] T034 [P] [US6] Extract `mapStreamError(err, config)` helper in src/engine/openai-stream.ts — replaces the 14-line ECONNREFUSED + HTTP status error mapping block duplicated at lines 28-42 and 76-89
- [x] T035 [P] [US6] Extract `emitGenEvent(status, extra?)` local helper in src/engine/implementer.ts — replaces 5 near-identical `onEvent?.({ type: 'implementer-generate', ... })` calls
- [x] T036 [US6] Extract `transitionAndEmit(state, projectDir, callbacks, transitionType, eventName)` helper in src/engine/orchestrator/planning.ts — replaces 4-5 duplicated `transition + saveState + onEvent + emit` patterns
- [x] T037 [US6] Forward `onEvent` callback to shell and agent backends — update `implementTaskViaShell`/`retryTaskViaShell` in src/engine/implementers/shell.ts and `implementTaskViaAgent`/`retryTaskViaAgent` in src/engine/implementers/agent.ts to accept and emit `implementer-generate` events; update routing in src/engine/implementer.ts to pass `onEvent` through (FR-020)

**Checkpoint**: No internal duplication. All implementer backends emit status events. Tests pass.

---

## Phase 9: User Story 7 — Consolidate Provider Knowledge (Priority: P3)

**Goal**: Provider base URLs defined in one place. Planner model access is type-safe. No confusing similar function names.

**Independent Test**: `npx tsc --noEmit` passes. Grep for `localhost:11434` and `localhost:1234` — each appears in exactly one file (providers.ts). Run `npx tsx --test tests/providers.test.ts tests/planner-detection.test.ts`.

### Implementation for User Story 7

- [x] T038 [US7] Export `DEFAULT_BASES` record from src/engine/providers.ts; update src/engine/detection.ts `IMPLEMENTER_CHECKS` to import and use base URLs from `DEFAULT_BASES` instead of hardcoding them
- [x] T039 [US7] Clarify naming: rename `buildProjectContext` in src/engine/planners/base.ts to `buildProjectContextMarkdown` (returns string) to distinguish from the orchestrator's `buildContext` (returns ProjectContext interface); update all call sites within base.ts

**Checkpoint**: Single source of truth for provider URLs. No naming confusion. Type-safe planner model access.

---

## Phase 10: User Story 8 — Fix Indentation and Structural Issues (Priority: P3)

**Goal**: Consistent formatting. No deceptive indentation. Max nesting ≤2 levels in logical code.

**Independent Test**: Visual inspection of modified files. `npx tsc --noEmit` passes.

### Implementation for User Story 8

- [x] T040 [US8] Fix try block indentation in src/engine/orchestrator/index.ts — indent lines 49-118 (the try body) by 2 additional spaces so they are visibly nested inside the try block
- [x] T041 [US8] Reduce nesting in `extractFrontmatter` in src/engine/spec/parser.ts — flatten the `depends_on` parsing branch (lines 104-117) using early continue or extracted helper to stay within 2 nesting levels
- [x] T042 [US8] Replace `buildSummary` inline type parameter (~280 chars) with `BuildSummaryState` from types.ts in src/engine/orchestrator/cost.ts

**Checkpoint**: All indentation correct. Nesting ≤2 levels. No structural issues.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Final verification across all changes

- [x] T043 Run `npx tsc --noEmit` — verify zero type errors across entire codebase
- [x] T044 Run full unit test suite — `npx tsx --test tests/formatter.test.ts tests/orchestrator.test.ts tests/implementer.test.ts tests/summary.test.ts tests/parser.test.ts tests/validator.test.ts tests/shell-implementer.test.ts tests/planners.test.ts tests/planner-version.test.ts tests/planner-detection.test.ts tests/providers.test.ts`
- [x] T045 Final quality scan — verify: no function >40 lines in src/engine/, no nesting >2 levels in logical code, no duplicated block of 4+ lines, no dead imports/exports, no misleading names
- [x] T046 Run quickstart.md verification — confirm the "Adding a New Planner Backend" guide from quickstart.md accurately describes the post-refactoring API

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — independent of US2-US8
- **US2 (Phase 4)**: Depends on Foundational + US1 completion (shell.ts uses shared parsers from US1)
- **US3 (Phase 5)**: Depends on Foundational — independent of US1/US2 (orchestrator doesn't use parsers/spawn directly)
- **US4 (Phase 6)**: Depends on US3 (helpers.ts functions are used by decomposed orchestrator code)
- **US5 (Phase 7)**: Depends on US2 (some renames done in US2), US4 (helpers.ts deleted)
- **US6 (Phase 8)**: Depends on US3 (decomposed functions), US4 (events.ts created)
- **US7 (Phase 9)**: Depends on Foundational (type changes)
- **US8 (Phase 10)**: Depends on US3 (decomposition resolves bare block scope)
- **Polish (Phase 11)**: Depends on ALL user stories complete

### User Story Dependencies

```
Setup → Foundational → US1 ──→ US2 ──────────→ US5
                     ↘ US3 → US4 → US6        ↗
                       ↘ US7 (independent)   ↗
                         ↘ US8 (after US3) ↗
                                           → Polish
```

### Parallel Opportunities

- **Foundational**: T003, T004, T005 — all parallel (different files)
- **US1**: T007 and T008 — parallel after T006 (different planner files)
- **US2**: T012/T013/T014 — parallel after T010/T011 (different planner files)
- **US3 and US1**: Can run in parallel if US1 finishes first or US3 doesn't touch parser-consuming files
- **US5**: T030, T031, T032 — all parallel (different files)
- **US6**: T034, T035 — parallel (different files)
- **US7**: Can run in parallel with US5, US6 (independent files)

---

## Parallel Example: User Story 2 (Planner Migration)

```bash
# After T010, T011 complete (spawn utility + factories added):

# Launch these 3 planner migrations in parallel:
Task T012: "Migrate codex.ts to shared spawn + factories"
Task T013: "Migrate opencode.ts to shared spawn + factories"
Task T014: "Migrate aider.ts to shared spawn + factories"

# Then sequentially:
Task T015: "Migrate shell.ts (depends on output-parsers from US1)"
Task T016: "Migrate claude-code.ts (most complex)"
Task T017: "Migrate final-review.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T005)
3. Complete Phase 3: US1 — Output Parser Extraction (T006-T009)
4. **STOP and VALIDATE**: `npx tsc --noEmit` + grep confirms single source of truth for parsers
5. Commit: "extract shared output parsers module"

### Incremental Delivery

1. Setup + Foundational → Baseline verified
2. US1 → Parsers consolidated → Commit
3. US2 → Spawn boilerplate eliminated → Commit
4. US3 → God functions decomposed → Commit
5. US4 → helpers.ts eliminated → Commit
6. US5 + US6 → Dead code removed, internal duplication fixed → Commit
7. US7 + US8 → Provider consolidation, formatting → Commit
8. Polish → Final verification → Ready for review

### Commit Strategy

One commit per completed user story (or logical group of P3 stories). Each commit must leave `npx tsc --noEmit` clean.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks in same phase
- [Story] label maps task to specific user story for traceability
- No test tasks included — spec does not request TDD; existing tests are updated as needed during implementation tasks
- Pre-existing orchestrator test failure (T002) must be fixed before US3 decomposition
- Total: 46 tasks across 11 phases (2 setup + 8 user stories + 1 polish)
