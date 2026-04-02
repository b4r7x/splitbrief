# Tasks: Deep Code Quality Remediation

**Input**: Design documents from `/specs/021-deep-quality-remediation/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Not included — spec does not request TDD or new test coverage. Existing tests must pass after each task.

**Organization**: Tasks grouped by user story (7 stories) to enable independent implementation. Each story is a self-contained increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Foundational (Type Definitions)

**Purpose**: Shared type changes that multiple stories depend on. Must complete before story work.

**CRITICAL**: These type changes are referenced by tasks in US1, US2, US3, and US4.

- [x] T001 Add `TuiEventType` derived type (`TuiEvent['type']`) and `TaskFrontmatter` interface to src/types.ts
- [x] T002 [P] Move `ClarificationQuestion` type from src/engine/question-parser.ts into src/types.ts, update imports in question-parser.ts and any consumers

**Checkpoint**: Type definitions ready — user story work can begin

---

## Phase 2: User Story 1 — Fix Critical Runtime Bugs (Priority: P1) MVP

**Goal**: Fix 3 critical bugs that cause data loss, type mismatches, or raw stack traces.

**Independent Test**: Open overlays during active workflow (no kill), cancel during question prompt (correct types), trigger CLI error (friendly message).

- [x] T003 [US1] Refactor overlay rendering in src/router.tsx — wrap screen in `<Box display={overlayActive === 'none' ? 'flex' : 'none'}>`, render overlays as conditional siblings instead of early-return replacements
- [x] T004 [P] [US1] Fix `resetMode` in src/hooks/use-input-mode.ts — split `resolverRef` into `reviewResolverRef` and `questionResolverRef` with proper types; `resetMode` resolves review with `{ approved: false }` and question with `''`
- [x] T005 [P] [US1] Add top-level error handler in src/cli.ts — change `program.parse()` to `program.parseAsync().catch(err => { console.error(err.message); process.exit(1); })`

**Checkpoint**: All 3 critical bugs fixed. Overlays preserve workflow, input mode types are correct, CLI errors are friendly.

---

## Phase 3: User Story 2 — Eliminate Code Duplication (Priority: P1)

**Goal**: Each duplicated pattern exists in exactly one place.

**Independent Test**: Verify each shared helper/hook is called from all former duplication sites, `tsc --noEmit` passes, all tests pass.

- [x] T006 [US2] Create `addUsageAndSave` helper in src/engine/orchestrator/helpers.ts that combines `addUsage` + `saveState`, update all 9 call sites in src/engine/orchestrator/index.ts, task-runner.ts, task-loop.ts, and planning.ts
- [x] T007 [P] [US2] Create planner once in `runWorkflow` (src/engine/orchestrator/index.ts) and pass to `handleRetryAndEscalation` via context in src/engine/orchestrator/task-runner.ts — remove duplicate `createPlanner` calls at task-runner.ts:133 and task-runner.ts:174
- [x] T008 [P] [US2] Create `useFilterableList` hook in src/hooks/use-filterable-list.ts — encapsulate filter state, clamped selectedIndex, wrap-around up/down, backspace, char input, escape handling
- [x] T009 [US2] Refactor src/ui/command-palette.tsx to use `useFilterableList` hook — remove inline filter/selectedIndex/keyboard logic
- [x] T010 [P] [US2] Refactor src/ui/skills-picker.tsx to use `useFilterableList` hook — remove inline filter/selectedIndex/keyboard logic, preserve toggle and navigating mode
- [x] T011 [P] [US2] Refactor src/ui/input-bar.tsx slash mode to use `useFilterableList` hook — remove inline filter/selectedIndex/keyboard logic in the `showSuggestions` branch
- [x] T012 [P] [US2] Update src/engine/planners/base.ts to use `accumulateUsage` from src/engine/output-parsers.ts instead of manual token accumulation
- [x] T013 [P] [US2] Update src/engine/planners/agent-sdk.ts to use `accumulateUsage` from src/engine/output-parsers.ts instead of manual token accumulation
- [x] T014 [P] [US2] Update src/engine/planners/opencode.ts to use `accumulateUsage` from src/engine/output-parsers.ts — remove `hasUsage` flag variant
- [x] T015 [P] [US2] Extract shared stream-json line handler in src/engine/planners/claude-code.ts — create `handleStreamJsonLine` used by both `spawnClaudePlanner` and `spawnClaudeWithStdin`
- [x] T016 [US2] Extract shared CLI command logic — create src/cli/shared.ts with common option builder and action base for start/resume commands in src/cli.ts; add `contextLengthOverride` to resume path

**Checkpoint**: All duplication eliminated. Each pattern exists once. `tsc --noEmit` and `npm test` pass.

---

## Phase 4: User Story 3 — Strengthen Type Safety (Priority: P2)

**Goal**: Compiler catches type errors that were previously runtime bugs.

**Independent Test**: Introduce deliberate type errors (wrong event name, wrong frontmatter field) and confirm compiler rejects them.

- [x] T017 [US3] Update `emit` function signature in src/engine/orchestrator/events.ts to use `OrchestratorEventType` instead of `string` for the `type` parameter
- [x] T018 [P] [US3] Update `extractFrontmatter` return type in src/engine/spec/parser.ts to `TaskFrontmatter | null` — add type narrowing for parsed YAML fields
- [x] T019 [P] [US3] Add null check for `proc.pid` in `killProcess` in src/utils/process.ts — guard `process.kill(proc.pid, 0)` call at line 29

**Checkpoint**: Event types, frontmatter, and process.pid are all type-safe. Compiler rejects invalid values.

---

## Phase 5: User Story 4 — Remove Dead Code (Priority: P2)

**Goal**: Codebase contains only code that is actually used.

**Independent Test**: Remove each dead symbol, verify build and tests pass.

- [x] T020 [P] [US4] Remove dead exports: unexport `GenEventEmitter` from src/engine/implementer.ts, `VALID_PLANNER_TOOLS` from src/config.ts, `AppContext` from src/app.tsx, `ShortcutInfo` from src/shortcuts.ts, `TaskStatus` from src/types.ts (UsageCategory kept — used by helpers.ts)
- [x] T021 [P] [US4] Remove dead exports: unexport `useTerminalSize` from src/hooks/use-terminal-size.ts, `parseBlocks` and `HighlightedCode` from src/ui/markdown.tsx, `slugify` and `readSession` from src/utils/sessions.ts
- [x] T022 [P] [US4] Remove 5 dead reducer actions (`SET_PHASE`, `SET_PROGRESS`, `INCREMENT_LOCAL`, `INCREMENT_ESCALATED`, `RESET`) and their case branches from src/hooks/use-workflow.ts
- [x] T023 [P] [US4] Remove miscellaneous dead code: redundant line 3 in src/utils/diff.ts, dead `offset` state in src/ui/review-view.tsx (replace with constant 0), unused `import React` in src/screens/home.tsx and src/screens/summary.tsx
- [x] T024 [P] [US4] Replace dynamic imports at src/cli.ts:109-111 with existing static imports (node:fs, node:path, yaml already imported at top of file)

**Checkpoint**: Zero dead exports. All tests pass. Build succeeds.

---

## Phase 6: User Story 5 — Restructure Oversized Files (Priority: P3)

**Goal**: No file exceeds 250 lines (excluding templates.ts). Each file has single responsibility.

**Independent Test**: All imports resolve, build succeeds, tests pass.

- [x] T025 [P] [US5] Split src/cli.ts — extract `runPicker` + `promptSelection` to src/cli/picker.ts, extract `renderApp` to src/cli/render.ts, extract workflow helpers to src/cli/workflow.ts
- [x] T026 [P] [US5] Split src/config.ts — extract `validateConfig` and helpers (`get`, field validators) to src/config-validation.ts, update imports in config.ts
- [x] T027 [P] [US5] Split src/engine/spec/formatter.ts — extract `estimateTokens`, `truncateMiddle`, `computeTokenBudget` to src/engine/spec/token-budget.ts, update imports in formatter.ts

**Checkpoint**: cli.ts under 150 lines, config.ts under 150 lines, formatter.ts under 150 lines. All imports resolve.

---

## Phase 7: User Story 6 — Fix Architecture Violations (Priority: P3)

**Goal**: Clean dependency graph with no layer violations.

**Independent Test**: All imports resolve, build passes, grep confirms no remaining violations.

- [x] T028 [P] [US6] Move src/engine/highlight.ts to src/utils/highlight.ts — update imports in src/ui/diff-view.tsx, src/ui/markdown.tsx
- [x] T029 [P] [US6] Move `DEFAULT_BASES` constant from src/engine/providers.ts to src/types.ts — update imports in config.ts, providers.ts, cli/picker.ts
- [x] T030 [P] [US6] Standardize React imports across all .tsx files — removed bare `import React` from router.tsx and tests/helpers/render.tsx

**Checkpoint**: No UI files import from engine/ for highlighting. No root modules depend on engine/. Consistent React import style.

---

## Phase 8: User Story 7 — Improve React Patterns (Priority: P3)

**Goal**: Optimal React patterns — incremental state, proper context, consistent theme access.

**Independent Test**: Profile render performance, verify all picker states, confirm theme consistency.

- [x] T031 [US7] Add `taskMap` field to `useWorkflow` reducer in src/hooks/use-workflow.ts — update `ADD_EVENT` case to maintain map incrementally from task-related events
- [x] T032 [US7] Replace `sidebarTasks` useMemo in src/screens/workflow.tsx with `taskMap` from the reducer state
- [x] T033 [P] [US7] Expand `AppContext` in src/app.tsx — add `projectDir` and skills state (`availableSkills`, `selectedSkillIds`, `onSkillsConfirm`, `selectedSkillMetas`), remove those props from src/router.tsx RouterProps interface
- [x] T034 [US7] Update src/screens/home.tsx, src/screens/workflow.tsx, and src/router.tsx to consume `projectDir` and skills from `useAppContext()` instead of props
- [x] T035 [P] [US7] Standardize theme access — remove `theme` prop from src/ui/input-bar.tsx, src/ui/slash-suggestions.tsx, src/ui/sidebar.tsx, src/ui/review-view.tsx; use `useAppContext()` in each
- [x] T036 [P] [US7] Fix picker dead state in src/ui/picker.tsx — handle case where 2+ planners and exactly 1 model by auto-selecting and calling `onComplete`
- [x] T037 [P] [US7] Stabilize `useInputMode` return values in src/hooks/use-input-mode.ts — wrap `setReviewMode`, `setQuestionMode`, `resolve`, `resetMode` in `useCallback`
- [x] T038 [P] [US7] Update list keys in src/ui/markdown.tsx — use content-based keys (e.g., `code-${i}-${block.code.slice(0,40)}`) instead of array index for `HighlightedCode` children
- [x] T039 [P] [US7] Update list keys in src/ui/diff-view.tsx — use content-based keys for diff lines; reset `highlighted` Map state to empty when `diff` prop changes
- [x] T040 [P] [US7] Reset async highlight state in src/ui/markdown.tsx `HighlightedCode` — call `setHl(null)` at start of useEffect when `code`/`lang` change
- [x] T041 [US7] Use `truncate` utility from src/ui/picker-utils.ts in src/screens/summary.tsx:83 instead of inline reimplementation

**Checkpoint**: Sidebar tasks update incrementally. Router has fewer props. Theme access is consistent. All picker states work. No stale highlight flashes.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup across all stories.

- [x] T042 Run `tsc --noEmit` and verify zero errors across entire codebase
- [x] T043 Run `npm test` and verify all tests pass (500 pass, 0 fail)
- [x] T044 Verify no file in src/ exceeds 250 lines (excluding templates.ts and types.ts — both are data/type files)
- [ ] T045 Run quickstart.md verification — start workflow, open overlay, close overlay, verify no interruption

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately
- **Phase 2 (US1 Critical Bugs)**: Depends on T001 (TuiEventType used by events.ts)
- **Phase 3 (US2 Duplication)**: Depends on Phase 2 completion (router + input mode must be stable)
- **Phase 4 (US3 Type Safety)**: Depends on T001 (types), can run parallel with Phase 3
- **Phase 5 (US4 Dead Code)**: Can run parallel with Phases 3-4 (independent files)
- **Phase 6 (US5 File Splits)**: Depends on Phases 3-5 (split after dedup and dead code removal)
- **Phase 7 (US6 Architecture)**: Depends on Phase 6 (move files after splits are stable)
- **Phase 8 (US7 React Patterns)**: Depends on Phase 7 (context expansion needs architecture stable)
- **Phase 9 (Polish)**: Depends on all phases complete

### User Story Dependencies

- **US1 (P1)**: Depends only on Phase 1 foundational types
- **US2 (P1)**: Depends on US1 (stable router + input mode)
- **US3 (P2)**: Depends on Phase 1; can run parallel with US2
- **US4 (P2)**: Independent — can run parallel with US2/US3
- **US5 (P3)**: Depends on US2 + US4 (split clean, deduplicated code)
- **US6 (P3)**: Depends on US5 (move files after splits)
- **US7 (P3)**: Depends on US6 (context expansion after architecture is clean)

### Within Each User Story

- Tasks marked [P] within the same phase can run in parallel
- Sequential tasks depend on prior tasks completing
- Each story ends with a checkpoint verification

### Parallel Opportunities

**Phase 2 (US1)**: T003, T004, T005 — all 3 critical bugs on different files, run in parallel
**Phase 3 (US2)**: T007-T015 — 9 of 11 tasks are parallelizable (different files)
**Phase 4 (US3)**: T017, T018, T019 — all 3 on different files, run in parallel
**Phase 5 (US4)**: T020-T024 — all 5 on different files, run in parallel
**Phase 6 (US5)**: T025, T026, T027 — all 3 splits are independent
**Phase 7 (US6)**: T028, T029, T030 — all 3 moves/fixes are independent
**Phase 8 (US7)**: T035-T041 — 8 of 11 tasks are parallelizable

---

## Parallel Example: Phase 3 (US2 — Duplication Elimination)

```
# Wave 1: Create shared abstractions (must complete first)
Agent 1: T006 — addUsageAndSave helper in orchestrator/helpers.ts
Agent 2: T008 — useFilterableList hook in hooks/use-filterable-list.ts

# Wave 2: Apply shared abstractions (all parallel, different files)
Agent 1: T007 — Single planner instance in orchestrator/index.ts + task-runner.ts
Agent 2: T009 — CommandPalette uses useFilterableList in ui/command-palette.tsx
Agent 3: T010 — SkillsPicker uses useFilterableList in ui/skills-picker.tsx
Agent 4: T011 — InputBar uses useFilterableList in ui/input-bar.tsx
Agent 5: T012 — base.ts uses accumulateUsage
Agent 6: T013 — agent-sdk.ts uses accumulateUsage
Agent 7: T014 — opencode.ts uses accumulateUsage
Agent 8: T015 — claude-code.ts shared stream handler

# Wave 3: CLI dedup (depends on T025 file split from Phase 6, or do inline first)
Agent 1: T016 — CLI start/resume shared logic
```

---

## Parallel Example: Phase 5 (US4 — Dead Code Removal)

```
# All 5 tasks can run simultaneously — completely independent files
Agent 1: T020 — Dead exports batch 1 (tokens.ts, implementer.ts, config.ts, app.tsx, shortcuts.ts, types.ts)
Agent 2: T021 — Dead exports batch 2 (use-terminal-size.ts, markdown.tsx, sessions.ts)
Agent 3: T022 — Dead reducer actions (use-workflow.ts)
Agent 4: T023 — Misc dead code (diff.ts, review-view.tsx, home.tsx, summary.tsx)
Agent 5: T024 — Dynamic import cleanup (cli.ts)
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Foundational types (T001-T002)
2. Complete Phase 2: Critical bug fixes (T003-T005) — **highest user impact**
3. Complete Phase 3: Duplication elimination (T006-T016) — **highest maintainability impact**
4. **STOP and VALIDATE**: Build, test, verify overlays work during workflow
5. This alone addresses 3 critical bugs + all major duplication

### Incremental Delivery

1. Phases 1-3 → Critical bugs + duplication fixed → **MVP complete**
2. Phase 4 → Type safety strengthened → Compiler catches more bugs
3. Phase 5 → Dead code removed → Cleaner codebase
4. Phase 6 → Files restructured → Easier navigation
5. Phase 7 → Architecture cleaned → Proper dependency graph
6. Phase 8 → React patterns improved → Better performance and consistency
7. Phase 9 → Final verification → Ship it

### Parallel Agent Strategy

With multi-agent execution:

1. **Phase 1**: 2 agents (T001 + T002 parallel) → ~5 min
2. **Phase 2**: 3 agents (T003, T004, T005 parallel) → ~10 min
3. **Phase 3**: 2 waves — 2 agents then 8 agents → ~20 min
4. **Phases 4+5**: Run simultaneously — 3 agents (US3) + 5 agents (US4) → ~10 min
5. **Phase 6**: 3 agents parallel → ~10 min
6. **Phase 7**: 3 agents parallel → ~5 min
7. **Phase 8**: 2 waves — 3 agents then 8 agents → ~15 min
8. **Phase 9**: 1 agent for verification → ~5 min

**Total estimated agent dispatches**: ~30 across all phases
**Maximum parallel agents per wave**: 8 (Phase 3 Wave 2)

---

## Notes

- [P] tasks = different files, no dependencies on other tasks in same wave
- [Story] label maps task to spec.md user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Run `tsc --noEmit` after every task that modifies .ts/.tsx files
- Run `npm test` after each phase checkpoint
