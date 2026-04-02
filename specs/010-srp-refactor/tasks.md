# Tasks: SRP Refactoring — Split Oversized Files into Focused Modules

**Input**: Design documents from `/specs/010-srp-refactor/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/module-boundaries.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Foundational — Types Module Split (Blocks Everything)

**Purpose**: Split monolithic `src/types.ts` (236 lines, 21 exports, 6 domains) into 5 domain-specific subfiles and update all import paths across the codebase. This MUST complete before any other work begins because every subsequent phase depends on the new import structure.

- [x] T001 Create src/types/core.ts with Phase, PermissionMode, TaskStatus, PlannerTool, OutputFormat, Task, Config, ProjectContext from src/types.ts
- [x] T002 [P] Create src/types/validation.ts with ValidationResult, TokenUsage, TaskTokenUsage, CostBreakdown, Summary from src/types.ts
- [x] T003 [P] Create src/types/spec.ts with TokenBudget, CodeContext from src/types.ts
- [x] T004 [P] Create src/types/tui.ts with TldrChangeset, TuiEvent, OrchestratorCallbacks from src/types.ts (imports from core.ts and validation.ts)
- [x] T005 [P] Create src/types/state.ts with WorkflowState, StateAction, Event from src/types.ts (imports from core.ts and validation.ts)
- [x] T006 Delete src/types.ts after all 5 subfiles are verified complete (depends on T001-T005)
- [x] T007 [P] Update imports in src/state.ts and src/config.ts to use new types/ subfiles
- [x] T008 [P] Update imports in src/cli.ts and src/app.tsx to use new types/ subfiles
- [x] T009 [P] Update imports in src/spec/parser.ts, src/spec/templates.ts, src/spec/formatter.ts to use new types/ subfiles
- [x] T010 [P] Update imports in src/orchestrator/orchestrator.ts, src/orchestrator/implementer.ts, src/orchestrator/validator.ts, src/orchestrator/escalator.ts to use new types/ subfiles
- [x] T011 [P] Update imports in src/orchestrator/tldr-parser.ts, src/orchestrator/providers.ts, src/orchestrator/planner-detection.ts, src/orchestrator/pricing.ts to use new types/ subfiles
- [x] T012 [P] Update imports in src/orchestrator/planners/types.ts, src/orchestrator/planners/factory.ts, src/orchestrator/planners/claude-code.ts, src/orchestrator/planners/codex.ts to use new types/ subfiles
- [x] T013 [P] Update imports in src/orchestrator/planners/aider.ts, src/orchestrator/planners/opencode.ts, src/orchestrator/planners/agent-sdk.ts, src/orchestrator/planners/shell.ts to use new types/ subfiles
- [x] T014 [P] Update imports in src/orchestrator/implementers/shell.ts, src/orchestrator/implementers/agent.ts to use new types/ subfiles
- [x] T015 [P] Update imports in src/tui/layout.tsx, src/tui/event-card.tsx, src/tui/conversation-flow.tsx, src/tui/pipeline-bar.tsx to use new types/ subfiles
- [x] T016 [P] Update imports in src/tui/cost-footer.tsx, src/tui/summary.tsx, src/tui/header.tsx, src/tui/picker.tsx to use new types/ subfiles
- [x] T017 [P] Update imports in src/tui/task-preview.tsx, src/tui/task-result.tsx, src/tui/review-gate.tsx, src/tui/mode-picker.tsx, src/tui/changes-card.tsx to use new types/ subfiles
- [x] T018 [P] Update imports in tests/state.test.ts, tests/orchestrator.test.ts, tests/pipeline-bar.test.ts, tests/event-card.test.ts to use new types/ subfiles
- [x] T019 [P] Update imports in tests/conversation-flow.test.ts, tests/changes-card.test.ts, tests/task-preview.test.ts, tests/task-result.test.ts to use new types/ subfiles
- [x] T020 Run npm test and npx tsc --noEmit to verify all 512 tests pass and no new compilation errors after types split (depends on T006-T019)

**Checkpoint**: Types module split complete. The acyclic two-level DAG (core/validation/spec at Level 0, tui/state at Level 1) is established. All imports updated and verified.

---

## Phase 2: User Story 1 — Orchestrator Split (Priority: P1)

**Goal**: Split the 1072-line orchestrator.ts into 5 focused modules so no file exceeds 400 lines and each has a single responsibility.

**Independent Test**: Each extracted module can be tested in isolation. A developer can find cost calculations by filename alone (orchestrator/cost.ts).

### Implementation for User Story 1

- [x] T021 [US1] Create WorkflowContext interface in src/types/tui.ts (or locally in orchestrator) with feature, projectDir, config, callbacks, startTime, planner, projectContext fields
- [x] T022 [US1] Extract estimateCostSavings and calculateCostBreakdown to src/orchestrator/cost.ts (pure functions, no I/O)
- [x] T023 [P] [US1] Extract runFinalReview to src/orchestrator/final-review.ts (subprocess management, receives projectDir + callbacks)
- [x] T024 [US1] Extract handleRetryAndEscalation and validateCommitAndAdvance to src/orchestrator/retry-escalation.ts (refactor to accept WorkflowContext as first parameter)
- [x] T025 [US1] Extract navigable approval loop (spec/plan/gate state machine, lines 410-582) to src/orchestrator/approval-loop.ts (accepts WorkflowContext, returns { state, aborted, summary? })
- [x] T026 [US1] Refactor residual src/orchestrator/orchestrator.ts to import from extracted modules, build WorkflowContext at workflow start, verify ≤400 lines
- [x] T027 [US1] Fix currentTasks variable in src/orchestrator/approval-loop.ts: after plan regeneration, re-parse tasks from tasks.md file using parseTasks() and reassign currentTasks
- [x] T028 [US1] Run npm test and npx tsc --noEmit to verify orchestrator split preserves all behavior (depends on T022-T027)

**Checkpoint**: Orchestrator split complete. orchestrator.ts ≤400 lines. Each module has a single responsibility: cost calculation, approval navigation, retry/escalation, final review.

---

## Phase 3: User Story 1 continued — App.tsx Decomposition (Priority: P1)

**Goal**: Extract 19 useState hooks from app.tsx (423 lines) into 3 custom hooks so the root component has ≤8 useState hooks.

**Independent Test**: App component is a thin shell (~80-100 lines). Each hook can be understood independently.

### Implementation for User Story 1 (App Hooks)

- [x] T029 [US1] Create src/tui/hooks/use-interaction.ts: extract approval, inputMode, taskPreview, taskReview states and their promise-based resolve patterns from src/app.tsx
- [x] T030 [US1] Create src/tui/hooks/use-workflow.ts: extract events, phase, currentTask, totalTasks, localCount, escalatedCount, model, startedAt, workflowStarted, summaryData states + the workflow useEffect + modeRef from src/app.tsx
- [x] T031 [US1] Create src/tui/hooks/use-app-navigation.ts: extract screen, feature, mode, overlay, slashOutput states + slash-command handler (lines 252-343) from src/app.tsx
- [x] T032 [US1] Refactor src/app.tsx to use the 3 custom hooks, verify ≤8 useState hooks remain, ~80-100 lines total
- [x] T033 [US1] Run npm test and npx tsc --noEmit to verify app decomposition preserves all behavior (depends on T029-T032)

**Checkpoint**: User Story 1 complete. No source file exceeds 400 lines. types.ts split into 5 subfiles. orchestrator.ts split into 5 modules. app.tsx delegates to 3 custom hooks. Every file has a single responsibility.

---

## Phase 4: User Story 2 — Type Safety and Deduplication (Priority: P1)

**Goal**: Replace 6 inline type duplications with shared named types so type changes propagate at compile time.

**Independent Test**: Changing a field in the canonical Task interface or adding a validation stage produces compile-time errors in every consumer.

### Implementation for User Story 2

- [x] T034 [US2] Add TaskSummaryInfo type alias (Pick<Task, 'id' | 'title' | 'action' | 'file'>) to src/types/tui.ts and use it in TuiEvent review-gate variant and OrchestratorCallbacks.onReviewGate
- [x] T035 [P] [US2] Add ValidationStages interface ({ tsc: boolean; lint: boolean; test: boolean }) to src/types/validation.ts and use it in TuiEvent validate variant and OrchestratorCallbacks.onTaskReview
- [x] T036 [P] [US2] Add TaskPreviewAction ('proceed' | 'skip') and TaskReviewAction ('commit' | 'retry' | 'skip' | 'edit') type aliases to src/types/tui.ts
- [x] T037 [US2] Update src/tui/review-gate.tsx to use TaskSummaryInfo instead of inline { id, title, action, file } shape (depends on T034)
- [x] T038 [P] [US2] Update src/tui/task-preview.tsx to use TaskPreviewAction and align action vocabulary ('proceed' not 'implement') (depends on T036)
- [x] T039 [P] [US2] Update src/tui/task-result.tsx to use TaskReviewAction and ValidationStages instead of inline types (depends on T035, T036)
- [x] T040 [US2] Update tests/review-gate.test.ts, tests/task-preview.test.ts, tests/task-result.test.ts to match updated action vocabulary (depends on T037-T039)
- [x] T041 [US2] Run npm test and npx tsc --noEmit to verify type deduplication (depends on T034-T040)

**Checkpoint**: User Story 2 complete. Zero inline type duplications. Every structural shape used in 2+ locations has a single named definition.

---

## Phase 5: User Story 3 — Bug Fixes (Priority: P2)

**Goal**: Fix 2 user-facing bugs: slash-input error persistence and diff line miscounting.

**Independent Test**: Type invalid slash command then valid one — autocomplete reappears. Diff with `+foo`/`-bar` lines counted correctly.

### Implementation for User Story 3

- [x] T042 [P] [US3] Fix src/tui/slash-input.tsx: clear error state in the onChange handler by adding setError(null) when query changes
- [x] T043 [P] [US3] Fix countDiffLines in src/tui/task-result.tsx: check for '+'/'-' at position 0 (not '+ '/'- '), exclude '+++' and '---' file headers
- [x] T044 [US3] Add test cases in tests/slash-input.test.ts (or tests/task-result.test.ts) covering error-clearing behavior and standard unified diff line counting (depends on T042-T043)
- [x] T045 [US3] Run npm test to verify bug fixes pass (depends on T044)

**Checkpoint**: User Story 3 complete. Both bugs fixed and covered by tests.

---

## Phase 6: User Story 4 — Dead Code and Import Hygiene (Priority: P3)

**Goal**: Remove unused imports, redundant dynamic imports, and consolidate duplicate rendering logic.

**Independent Test**: No unused imports remain. No inline `import('...')` type expressions exist where static import suffices.

### Implementation for User Story 4

- [x] T046 [P] [US4] Remove unused TuiEvent import from src/orchestrator/orchestrator.ts and add PermissionMode to top-level import (replacing inline import type expression)
- [x] T047 [P] [US4] Remove unused Task import from src/state.ts
- [x] T048 [P] [US4] Replace redundant dynamic imports in src/orchestrator/planners/codex.ts (runCommand already static, add parseVersion as static import)
- [x] T049 [P] [US4] Replace redundant dynamic imports in src/orchestrator/planners/aider.ts (runCommand already static, add parseVersion as static import)
- [x] T050 [P] [US4] Replace redundant dynamic imports in src/orchestrator/planners/opencode.ts (runCommand already static, add parseVersion as static import)
- [x] T051 [P] [US4] Replace redundant dynamic imports in src/orchestrator/planners/claude-code.ts (add runCommand + parseVersion as static imports)
- [x] T052 [P] [US4] Replace redundant dynamic imports in src/cli.ts init function (add mkdirSync, writeFileSync, join, YAML as static imports)
- [x] T053 [US4] Refactor inline import type in src/types/tui.ts: replace import('./orchestrator/question-parser.js').ClarificationQuestion with top-level import type
- [x] T054 [US4] Consolidate ValidateContent duplication in src/tui/event-card.tsx: remove inline case 'validate' body and use the exported ValidateContent component
- [x] T055 [US4] Run npm test and npx tsc --noEmit to verify dead code removal (depends on T046-T054)

**Checkpoint**: User Story 4 complete. Zero unused imports. Zero redundant dynamic imports. No inline import type expressions.

---

## Phase 7: User Story 5 — Prop Type Tightening (Priority: P3)

**Goal**: Narrow overly broad `string` props to constrained union types.

**Independent Test**: Passing an invalid value to a tightened prop produces a compile-time error.

### Implementation for User Story 5

- [x] T056 [P] [US5] Tighten onOverlayChange callback type in src/tui/layout.tsx from (overlay: string) => void to (overlay: 'none' | 'mode-picker' | 'help') => void
- [x] T057 [P] [US5] Tighten color prop type in src/tui/dialog-card.tsx from string to a constrained terminal color union type
- [x] T058 [P] [US5] Type onSelect callback in src/tui/slash-input.tsx with a typed slash command union instead of bare string
- [x] T059 [US5] Update any callers of tightened props in src/app.tsx or src/tui/hooks/ that pass string literals to use the new union types (depends on T056-T058)
- [x] T060 [US5] Run npm test and npx tsc --noEmit to verify type tightening (depends on T056-T059)

**Checkpoint**: User Story 5 complete. All component props use constrained types.

---

## Phase 8: Polish & Verification

**Purpose**: Final verification that all success criteria are met.

- [x] T061 Run full test suite: npm test — 518 pass, 0 fail, 14 skipped (6 new tests from bug fixes)
- [x] T062 Run npx tsc --noEmit — only pre-existing agent-sdk errors, no new errors
- [x] T063 Verify source file sizes: orchestrator.ts 405 lines (down from 1072), app.tsx ~130 lines (down from 423). templates.ts 429 (cohesive, acknowledged exception)
- [x] T064 Verify type dependency graph is acyclic: core/validation/spec have no cross-imports; tui/state import only from Level 0 files
- [x] T065 Verify no inline import('...') type expressions remain in src/ (excluding legitimate factory.ts and agent-sdk.ts dynamic imports)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately. BLOCKS all subsequent phases.
- **Phase 2 (US1 Orchestrator)**: Depends on Phase 1 completion
- **Phase 3 (US1 App.tsx)**: Depends on Phase 1 completion (can run in parallel with Phase 2)
- **Phase 4 (US2 Type Dedup)**: Depends on Phase 1 completion (can run in parallel with Phases 2-3)
- **Phase 5 (US3 Bugs)**: Depends on Phase 1 completion (can run in parallel with Phases 2-4)
- **Phase 6 (US4 Dead Code)**: Depends on Phase 1 completion + Phase 2 (orchestrator must be split before cleaning its imports)
- **Phase 7 (US5 Prop Types)**: Depends on Phase 1 completion (can run in parallel with Phases 2-5)
- **Phase 8 (Polish)**: Depends on all previous phases

### User Story Dependencies

- **US1 (P1)**: Orchestrator split (Phase 2) and App.tsx decomposition (Phase 3) can run in parallel after Phase 1
- **US2 (P1)**: Type dedup can run in parallel with US1 after Phase 1
- **US3 (P2)**: Bug fixes are independent — can run in parallel with everything after Phase 1
- **US4 (P3)**: Dead code removal should follow orchestrator split (Phase 2) since some cleanup targets are in orchestrator.ts
- **US5 (P3)**: Prop tightening is independent — can run in parallel with everything after Phase 1

### Within Each Phase

- Tasks marked [P] within the same phase can run in parallel
- Verification tasks (T020, T028, T033, T041, T045, T055, T060) must run after their phase's implementation tasks

### Parallel Opportunities

After Phase 1 completes, up to 5 user stories can proceed in parallel:

```
Phase 1 (Foundation) ──┬──> Phase 2 (US1 Orchestrator) ──> Phase 3 (US1 App.tsx)
                       ├──> Phase 4 (US2 Type Dedup)
                       ├──> Phase 5 (US3 Bugs)
                       ├──> Phase 6 (US4 Dead Code) [after Phase 2]
                       └──> Phase 7 (US5 Prop Types)
                                All ──> Phase 8 (Polish)
```

---

## Parallel Example: Phase 1 Foundation

```bash
# Launch all 5 type subfile creations in parallel:
Task: "Create src/types/core.ts with Phase, PermissionMode, TaskStatus, ..."
Task: "Create src/types/validation.ts with ValidationResult, TokenUsage, ..."
Task: "Create src/types/spec.ts with TokenBudget, CodeContext"
Task: "Create src/types/tui.ts with TldrChangeset, TuiEvent, ..."
Task: "Create src/types/state.ts with WorkflowState, StateAction, Event"

# After T006 (delete old types.ts), launch all import updates in parallel:
Task: "Update imports in src/state.ts and src/config.ts"
Task: "Update imports in src/cli.ts and src/app.tsx"
Task: "Update imports in src/spec/parser.ts, templates.ts, formatter.ts"
Task: "Update imports in src/orchestrator/orchestrator.ts, implementer.ts, ..."
# ... all T007-T019 in parallel
```

## Parallel Example: After Phase 1

```bash
# Launch US1, US2, US3, US5 in parallel:
Agent A: Phase 2 (US1 Orchestrator) — T021-T028
Agent B: Phase 4 (US2 Type Dedup) — T034-T041
Agent C: Phase 5 (US3 Bugs) — T042-T045
Agent D: Phase 7 (US5 Prop Types) — T056-T060

# After Phase 2 completes:
Agent A: Phase 3 (US1 App.tsx) — T029-T033
Agent E: Phase 6 (US4 Dead Code) — T046-T055
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational types split + import updates
2. Complete Phase 2: Orchestrator split (orchestrator.ts ≤400 lines)
3. Complete Phase 3: App.tsx decomposition (≤8 useState hooks)
4. **STOP and VALIDATE**: All 512 tests pass, no file >400 lines
5. This delivers the core value: navigable, single-responsibility modules

### Incremental Delivery

1. Phase 1 (Foundation) → Types split verified
2. Phase 2-3 (US1) → Orchestrator + App decomposed → Verify
3. Phase 4 (US2) → Type safety established → Verify
4. Phase 5 (US3) → Bugs fixed → Verify
5. Phase 6-7 (US4+US5) → Cleanup and tightening → Verify
6. Phase 8 → Final verification

### Parallel Agent Strategy

With multiple parallel agents (after Phase 1):

1. All agents complete Phase 1 together (or single agent handles it)
2. Once Phase 1 is done:
   - Agent A: US1 Orchestrator split (Phase 2) → US1 App.tsx (Phase 3)
   - Agent B: US2 Type dedup (Phase 4)
   - Agent C: US3 Bug fixes (Phase 5)
   - Agent D: US5 Prop tightening (Phase 7)
   - Agent E (after Phase 2): US4 Dead code (Phase 6)
3. Phase 8 verification after all agents complete

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- All test/tsc verification checkpoints are critical — never skip them
- The types split (Phase 1) is the single biggest risk: 45+ files change imports. Verify immediately.
- Keep the existing `import type` convention and `.js` extensions per constitution Principle IV
- The `WorkflowContext` interface is a plain record, NOT a class, per constitution Principle IV
