# Tasks: Code Quality Audit Remediation

**Input**: Design documents from `/specs/022-quality-audit-fixes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Test tasks included only for test quality improvements (US6). All other stories verified via existing test suite.

**Organization**: Tasks grouped by user story. Foundational phase contains cross-cutting type/utility changes needed by multiple stories.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create new utility files and modules that other phases depend on.

- [x] T001 [P] Create `src/utils/errors.ts` with `toErrorMessage(err: unknown): string` utility function
- [x] T002 [P] Add `readFileOrEmpty(path: string): string` function to `src/utils/fs.ts`
- [x] T003 [P] Create `tests/helpers/react-tree.ts` with shared `collectText()` and `findText()` React element tree traversal helpers (extract from `tests/cost-footer.test.ts` and `tests/event-card.test.ts`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type system changes, activeProcesses encapsulation, and dead code removal that MUST complete before user story work begins.

**CRITICAL**: No user story work can begin until this phase is complete.

### Type System Foundation (US4 + US5 cross-cutting)

- [x] T004 [P] Move `DEFAULT_BASES` runtime constant from `src/types.ts` to `src/engine/providers.ts`, remove re-export from `providers.ts`, update all import paths (`src/engine/detection.ts`, `src/config.ts`, `src/cli/picker.ts`, `src/config-validation.ts`) — FR-020, FR-035
- [x] T005 [P] Export `TaskStatus` type from `src/types.ts` — FR-021
- [x] T006 [P] Rename `Event` interface to `OrchestratorEvent` in `src/types.ts:208`, update import in `src/state.ts:3` and parameter type at `src/state.ts:156` — FR-025
- [x] T007 [P] Unify `ImplementerTokenUsage` fields: change `promptTokens`/`completionTokens` to `inputTokens`/`outputTokens` in `src/types.ts:123`, update `src/engine/openai-stream.ts:82-83`, remove `toImplUsage` in `src/engine/implementers/shell.ts:69-70`, simplify `addUsage` in `src/engine/orchestrator/tokens.ts:17-18`, update `tests/openai-stream.test.ts:82` — FR-023
- [x] T008 [P] Type `TuiEvent` planner-status `phase` field as `Phase` instead of `string` in `src/types.ts`, remove unsafe cast in `src/hooks/use-workflow.ts:48` — FR-024
- [x] T009 [P] Deduplicate `SidebarTask`: define once in `src/types.ts`, remove duplicate from `src/ui/sidebar.tsx:6`, import in both `src/ui/sidebar.tsx` and `src/hooks/use-workflow.ts` — FR-022
- [x] T010 Colocate single-consumer types: move `TaskFrontmatter` from `src/types.ts:322` to `src/engine/spec/parser.ts`, move `BuildSummaryState` from `src/types.ts:290` to `src/engine/orchestrator/cost.ts`, make `src/engine/question-parser.ts` the canonical source for `ClarificationQuestion` (remove from `src/types.ts:330`, update consumers) — FR-026

### Dead Code & Anti-Slop Foundation (US5)

- [x] T011 [P] [US5] Delete `src/ui/picker.tsx` (158 lines, zero imports) — FR-012
- [x] T012 [P] [US5] Remove dead exports: unexport `getVisibleWindow` and `estimateEventHeight` from `src/utils/event-sections.ts`, remove dead `TuiEventType` export from `src/types.ts:292` — FR-030
- [x] T013 [P] [US5] Remove `?? undefined` no-ops in `src/engine/implementer.ts:115` and `src/engine/implementers/shell.ts:110` — FR-033
- [x] T014 [P] [US5] Remove `export` keyword from `parseFrontmatter` and `loadSkillContent` in `src/engine/skills.ts` — FR-032
- [x] T015 [P] [US5] Remove 5 section divider comments (`// ── command ──...`) from `src/cli.ts:24,46,91,110,141` — FR-031

### Process Encapsulation

- [x] T016 Encapsulate `activeProcesses` Set in `src/utils/process.ts`: replace mutable export with `registerProcess()` and `unregisterProcess()` functions, update consumers in `src/engine/planners/spawn.ts` and `src/engine/implementers/agent.ts` — FR-006

**Checkpoint**: Foundation ready — type system clean, dead code removed, utilities created. User story implementation can now begin in parallel.

---

## Phase 3: User Story 1 - Runtime Bug Elimination (Priority: P1)

**Goal**: Fix 5 critical runtime bugs that cause crashes, race conditions, broken scrolling, and wrong cost calculations.

**Independent Test**: `npm test` passes. TUI launches without crashes. Review mode scrolls. OpenRouter shows non-zero costs.

### Implementation for User Story 1

- [x] T017 [P] [US1] Replace `process.exit(2)` with thrown error in `src/hooks/use-config.ts:20` — the error should be catchable by React error boundaries and display the config error message to the user — FR-001
- [x] T018 [P] [US1] Fix race condition in `src/hooks/use-input-mode.ts:27-37`: capture `modeRef.current` into a local variable before calling `setModeState({ mode: 'normal', hint: '' })`, then use the captured value for resolver dispatch — FR-002
- [x] T019 [US1] Fix bidirectional sync in `src/ui/input-bar.tsx`: remove both sync useEffects (lines 66-77), compute filtered list from `value` via `useMemo`, pass pre-filtered items to `useFilterableList` with pass-through `filterFn`, let hook manage only selection navigation — FR-003
- [x] T020 [P] [US1] Implement keyboard-driven scroll in `src/ui/review-view.tsx`: replace dead `const offset = 0` with `useState` scroll state, add up/down arrow key handling via `useInput`, update visible window calculation — FR-004
- [x] T021 [P] [US1] Add OpenRouter pricing to `src/engine/pricing.ts`: add `openrouter` entry to `PRICING` table or `getImplementerPricing` with reasonable cloud pricing estimates instead of returning `LOCAL_PRICING` — FR-005

**Checkpoint**: All 5 runtime bugs fixed. TUI is crash-free and functionally correct.

---

## Phase 4: User Story 2 - Code Maintainability (Priority: P2)

**Goal**: Consolidate 7 DRY patterns, decompose oversized functions, split template file, break circular dependency.

**Independent Test**: No function >50 lines. No file >250 lines (except template barrel). Zero circular dependencies. 7 DRY patterns consolidated.

### Engine DRY Consolidation

- [x] T022 [US2] Extract `createGenEventEmitter` and `processImplementerOutput` from `src/engine/implementer.ts` to new `src/engine/implementer-utils.ts`, update imports in `src/engine/implementer.ts` and `src/engine/implementers/shell.ts` — FR-019
- [x] T023 [US2] Add `spawnAndCollect()` shared function to `src/engine/planners/spawn.ts` that handles text accumulation + usage tracking with a configurable line parser — FR-017
- [x] T024 [P] [US2] Refactor `src/engine/planners/codex.ts` to use `spawnAndCollect()` from `spawn.ts` — FR-017
- [x] T025 [P] [US2] Refactor `src/engine/planners/opencode.ts` to use `spawnAndCollect()` from `spawn.ts` — FR-017
- [x] T026 [P] [US2] Refactor `src/engine/planners/shell.ts` to use `spawnAndCollect()` from `spawn.ts` — FR-017
- [x] T027 [P] [US2] Refactor `src/engine/planners/aider.ts` to use `spawnAndCollect()` from `spawn.ts` — FR-017
- [x] T028 [US2] Add `createTextHandler()` to `src/engine/orchestrator/events.ts` and replace 7 inline text handler patterns across `src/engine/orchestrator/task-loop.ts`, `src/engine/orchestrator/task-runner.ts`, `src/engine/orchestrator/planning.ts`, `src/engine/orchestrator/final-review.ts` — FR-016

### Orchestrator Decomposition

- [x] T029 [US2] Extract `initializeWorkflow()` and `runFinalReviewPhase()` as file-local helpers in `src/engine/orchestrator/index.ts`, reducing `runWorkflow` to ~40 lines — FR-009
- [x] T030 [US2] Extract `collectAndPersistClarifications()` as file-local helper in `src/engine/orchestrator/planning.ts`, reducing `runPlanningPhase` to ~65 lines — FR-009
- [x] T031 [US2] Extract `checkExternalChanges()` and `handleSkippedTask()` as file-local helpers in `src/engine/orchestrator/task-loop.ts`, reducing `runTaskLoop` to ~75 lines — FR-009
- [x] T032 [US2] Create `src/engine/orchestrator/escalation.ts` by moving `runLocalRetries`, `runTier1Hint`, `runTier2Full`, `handleRetryAndEscalation`, `EscalationContext`, `RetryResult`, `implementerTextHandler`, `validateAndCommit` from `src/engine/orchestrator/task-runner.ts`. Update import in `src/engine/orchestrator/task-loop.ts` — FR-010

### Template Split

- [x] T033 [P] [US2] Create `src/engine/spec/planning-prompts.ts` with `buildResearchPrompt`, `buildSpecPrompt`, `buildPlanPrompt`, `buildRegeneratePrompt`, `buildTasksPrompt` extracted from `src/engine/spec/templates.ts` — FR-007
- [x] T034 [P] [US2] Create `src/engine/spec/execution-prompts.ts` with `buildHintPrompt`, `buildEscalationPrompt` extracted from `src/engine/spec/templates.ts` — FR-007
- [x] T035 [P] [US2] Create `src/engine/spec/review-prompts.ts` with `buildFinalReviewPrompt` extracted from `src/engine/spec/templates.ts` — FR-007
- [x] T036 [US2] Convert `src/engine/spec/templates.ts` to barrel re-export (~10 lines) importing from the 3 new prompt files — FR-007

### Agent Decomposition

- [x] T037 [US2] Extract `interpretAgentResult()` from `runAgentImplementer` in `src/engine/implementers/agent.ts` as file-local helper — FR-014

### DRY Consumer Updates

- [x] T038 [US2] Replace 8 inline `err instanceof Error ? err.message : String(err)` patterns with `toErrorMessage()` from `src/utils/errors.ts` in: `src/engine/orchestrator/index.ts` (x2), `src/engine/orchestrator/planning.ts`, `src/engine/detection.ts`, `src/engine/implementer.ts`, `src/engine/apply.ts`, `src/engine/implementers/shell.ts`, `src/engine/implementers/agent.ts` — FR-015
- [x] T039 [US2] Replace 3 inline `existsSync ? readFileSync : ''` patterns with `readFileOrEmpty()` from `src/utils/fs.ts` in: `src/engine/implementer.ts` (x2), `src/engine/implementers/shell.ts` — FR-018

**Checkpoint**: All DRY patterns consolidated, oversized functions decomposed, templates split, circular dep broken.

---

## Phase 5: User Story 3 - React Pattern Correctness (Priority: P2)

**Goal**: Fix React anti-patterns, extract components, improve hook stability, decompose god component.

**Independent Test**: `npm test` passes. Skills picker works smoothly. Bold/italic renders correctly. Spinner in own file.

### Implementation for User Story 3

- [x] T040 [P] [US3] Extract `Spinner` component from `src/ui/event-card.tsx` (lines 16-30) to new `src/ui/spinner.tsx`, update import in `event-card.tsx` — FR-029
- [x] T041 [P] [US3] Fix `React.JSX.Element` return type to `JSX.Element` in `src/ui/event-card.tsx:169` — FR-013
- [x] T042 [P] [US3] Fix bold/italic interaction in `src/ui/markdown.tsx:52-76`: update `renderMarkdownLine` so that `*italic*` renders correctly when `**bold**` is also present on the same line — FR-027
- [x] T043 [P] [US3] Add `useCallback` wrappers to returned functions in `src/hooks/use-overlay.ts` (`open`, `close`) — FR-028
- [x] T044 [P] [US3] Add `useCallback` wrappers to returned functions in `src/hooks/use-sidebar.ts` (`toggle`) — FR-028
- [x] T045 [P] [US3] Add `useCallback` wrapper to `navigate` function in `src/hooks/use-router.ts` — FR-028
- [x] T046 [US3] Decompose `src/ui/skills-picker.tsx` (204 lines): extract scroll/toggle logic so main component body is under 100 lines — FR-008
- [x] T047 [US3] Replace `as any` casts with minimal typed response interfaces in `src/engine/providers.ts:35,45-46` (Ollama and LM Studio API responses) and `src/engine/detection.ts:65,70` (model list responses) — FR-034
- [x] T048 [US3] Use refs for closure-captured values (`config`, `onComplete`, `resumeState`) in `src/hooks/use-workflow.ts` useEffect (lines 101-147) to eliminate stale closure risk — FR-011

**Checkpoint**: All React patterns correct. Hooks stable. Components decomposed. Type-safe API responses.

---

## Phase 6: User Story 4 - Type System Integrity (Priority: P3)

**Note**: Most US4 tasks were completed in the Foundational phase (T004-T010) because type changes are prerequisites for other stories. No remaining tasks — US4 is fully covered by Phase 2.

**Checkpoint**: Type system integrity achieved via Phase 2 foundational tasks.

---

## Phase 7: User Story 5 - Dead Code and Anti-Slop (Priority: P3)

**Note**: Most US5 tasks were completed in the Foundational phase (T011-T015) because dead code removal is a prerequisite for clean refactoring. One remaining task:

- [x] T049 [US5] Remove orphaned `filterCommands` export from `src/ui/slash-suggestions.tsx` and `filterSkills` export from `src/ui/skills-picker.tsx`, update tests to exercise the actual runtime filtering path through `useFilterableList` — FR-040

**Checkpoint**: All dead code removed, anti-slop patterns cleaned.

---

## Phase 8: User Story 6 - Test Quality Improvement (Priority: P3)

**Goal**: Fix misleading tests, deduplicate test helpers, consolidate factories.

**Independent Test**: `npm test` passes. Shared helpers used consistently. Tests verify behavior, not type construction.

### Implementation for User Story 6

- [x] T050 [P] [US6] Update `tests/cost-footer.test.ts` to import `collectText`/`findText` from `tests/helpers/react-tree.ts`, remove local duplicates — FR-038
- [x] T051 [P] [US6] Update `tests/event-card.test.ts` to import `collectText`/`findText` from `tests/helpers/react-tree.ts`, remove local duplicates — FR-038
- [x] T052 [P] [US6] Consolidate `makeTask` in `tests/state.test.ts`: remove local factory, import shared `makeTask` from `tests/helpers/fixtures.ts` — FR-039
- [x] T053 [P] [US6] Consolidate `makeTask` in `tests/integration/resume.integration.test.ts` and `tests/integration/retry.integration.test.ts`: remove local factories, import from `tests/helpers/fixtures.ts` — FR-039
- [x] T054 [US6] Rewrite `tests/events.test.ts` to test actual event emission behavior from orchestrator `emit()` and `allValidationsPassed()`, not TypeScript discriminated union type narrowing — FR-036
- [x] T055 [US6] Rewrite `tests/diff-view.test.ts` to test the actual `DiffView` component exports and rendering behavior, not a locally reimplemented `classifyLine` function — FR-037

**Checkpoint**: Test suite verifies behavior, shared helpers deduplicated, factories consolidated.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup.

- [x] T056 Run `npm test` and verify all tests pass
- [x] T057 Run `npx tsc --noEmit` and verify zero type errors
- [x] T058 Verify success criteria: no function >60 lines, no file >250 lines, zero circular deps, zero `?? undefined`, zero `as any` (except agent-sdk optional import)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001-T003) — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 completion — independent of other stories
- **US2 (Phase 4)**: Depends on Phase 2 completion — T022 must complete before T024-T027; T028 before T029-T032; T033-T035 before T036
- **US3 (Phase 5)**: Depends on Phase 2 completion — independent of US1/US2
- **US4 (Phase 6)**: Fully covered by Phase 2 foundational tasks
- **US5 (Phase 7)**: Mostly covered by Phase 2; T049 depends on Phase 2
- **US6 (Phase 8)**: Depends on all other phases (tests must verify final state)
- **Polish (Phase 9)**: Depends on all phases complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 — No dependencies on other stories
- **US2 (P2)**: Can start after Phase 2 — T038-T039 depend on T001-T002 (utilities)
- **US3 (P2)**: Can start after Phase 2 — No dependencies on US1/US2
- **US4 (P3)**: Completed in Phase 2
- **US5 (P3)**: Mostly completed in Phase 2; T049 independent
- **US6 (P3)**: Should run last after all source changes are final

### Parallel Opportunities

**Phase 1** (3 tasks, all [P]): T001 || T002 || T003

**Phase 2** (13 tasks, most [P]):
- Parallel group A: T004 || T005 || T006 || T007 || T008 || T009
- Sequential after A: T010 (depends on type moves in T004-T009)
- Parallel group B (independent of A): T011 || T012 || T013 || T014 || T015
- Sequential: T016 (touches process.ts shared by multiple modules)

**Phase 3** (5 tasks): T017 || T018 || T020 || T021 (all [P]); T019 sequential

**Phase 4** (18 tasks):
- T022 first (creates implementer-utils.ts), then T024 || T025 || T026 || T027 in parallel
- T023 first (creates spawnAndCollect), then T024-T027 can use it
- T033 || T034 || T035 in parallel, then T036
- T029 || T030 || T031 in parallel after T028
- T037 || T038 || T039 independent

**Phase 5** (9 tasks): T040 || T041 || T042 || T043 || T044 || T045 all parallel; T046-T048 sequential

**Phase 8** (6 tasks): T050 || T051 || T052 || T053 all parallel; T054, T055 sequential

---

## Parallel Example: Phase 2 Foundational

```
# Launch all independent type changes together:
Agent 1: T004 — Move DEFAULT_BASES to providers.ts
Agent 2: T005 — Export TaskStatus
Agent 3: T006 — Rename Event → OrchestratorEvent
Agent 4: T007 — Unify token field names
Agent 5: T008 — Type planner-status.phase as Phase
Agent 6: T009 — Deduplicate SidebarTask

# Launch all dead code removal together:
Agent 7: T011 — Delete picker.tsx
Agent 8: T012 — Remove dead exports
Agent 9: T013 — Remove ?? undefined
Agent 10: T014 — Unexport skills.ts functions
Agent 11: T015 — Remove CLI section dividers
```

## Parallel Example: Phase 4 Planner DRY

```
# After T023 (spawnAndCollect) completes:
Agent 1: T024 — Refactor codex.ts
Agent 2: T025 — Refactor opencode.ts
Agent 3: T026 — Refactor shell.ts
Agent 4: T027 — Refactor aider.ts
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (3 tasks)
2. Complete Phase 2: Foundational (13 tasks)
3. Complete Phase 3: US1 — Runtime Bugs (5 tasks)
4. **STOP and VALIDATE**: All 5 runtime bugs fixed, tests pass
5. Can ship this increment alone for immediate stability improvement

### Incremental Delivery

1. Setup + Foundational → Foundation ready (16 tasks)
2. Add US1 → Runtime bugs fixed → Ship (5 tasks)
3. Add US2 → DRY patterns consolidated → Ship (18 tasks)
4. Add US3 → React patterns correct → Ship (9 tasks)
5. Add US5 → Dead code cleaned → Ship (1 task)
6. Add US6 → Tests improved → Ship (6 tasks)
7. Polish → Verify all criteria → Done (3 tasks)

### Multi-Agent Strategy

With 10-20 agents:

1. **10 agents**: Phase 2 foundational tasks (all [P], different files)
2. After Phase 2:
   - **5 agents**: US1 runtime fixes (Phase 3, all [P])
   - **4 agents**: US2 planner DRY + template split (Phase 4, [P] groups)
   - **6 agents**: US3 React fixes (Phase 5, all [P])
3. **2 agents**: US2 orchestrator decomposition (Phase 4, sequential)
4. **2 agents**: US2 DRY consumers + US5 cleanup (Phase 4-7)
5. **4 agents**: US6 test quality (Phase 8, [P] tasks)
6. **1 agent**: Polish verification (Phase 9)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US4 and US5 are mostly embedded in Phase 2 (Foundational) since type changes and dead code removal are prerequisites
- Each checkpoint verifies `npm test` + `npx tsc --noEmit`
- Commit after each task or logical group
- Total: 58 tasks across 9 phases covering 40 functional requirements
