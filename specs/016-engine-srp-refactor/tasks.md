# Tasks: Engine SRP & DRY Refactoring

**Input**: Design documents from `/specs/016-engine-srp-refactor/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/module-boundaries.md

**Tests**: No new test files. Existing tests must pass with import path updates only.

**Organization**: Tasks are grouped by user story. US1-US3 can execute in parallel (disjoint file sets). US4-US6 can execute in parallel after US1-US3 complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Foundational

**Purpose**: No foundational tasks needed — this is a refactoring of an existing codebase with no new infrastructure.

**Checkpoint**: Ready to begin user story implementation immediately.

---

## Phase 2: User Story 1 — Planner Base Extraction (Priority: P1) 🎯 MVP

**Goal**: Extract shared planner logic into `src/engine/planners/base.ts` so each planner only contains tool-specific code. Eliminate ~940 duplicated LOC across 6 planner files.

**Independent Test**: `npm test && npm run build` passes. Each planner file is under 180 lines. All planner-related tests pass unchanged.

### Implementation for User Story 1

- [x] T001 [US1] Create shared planner base module at `src/engine/planners/base.ts`: Define `InvokeResult` interface, `InvokeFn` type, `PlannerBaseConfig` interface. Move `buildProjectContext()` and `listDir()` from `src/engine/planners/claude-code.ts` (lines 22-80). Implement `createPlannerBase(config)` factory that returns a complete `PlannerBackend` with shared `plan()` (4-phase loop calling `invokePlan` 4 times with prompt templates, writing spec files, accumulating usage, parsing tasks), `regenerate()`, `escalateHint()`, `escalateFull()`, and `getPricing()`. See `specs/016-engine-srp-refactor/research.md` section 1 for exact type signatures and implementation design.

- [x] T002 [P] [US1] Migrate `src/engine/planners/codex.ts` to use `createPlannerBase`: Remove `buildProjectContext`, `listDir`, the `plan()` body, `regenerate()`, `escalateHint()`, `escalateFull()` boilerplate. Keep `parseCodexLine` and `spawnCodex`. Export `createCodexPlanner()` that calls `createPlannerBase()` with codex-specific `invokePlan`/`invokeEscalate` (wrapping `spawnCodex`), `isAvailable`, `getVersion`. Run `npm test` to verify.

- [x] T003 [P] [US1] Migrate `src/engine/planners/opencode.ts` to use `createPlannerBase`: Same pattern as T002. Keep `parseNdjsonLine` and `spawnOpenCode`. Remove duplicated `buildProjectContext`, `listDir`, plan loop, regenerate, escalation boilerplate. Remove unused `activeProcesses` import. Run `npm test` to verify.

- [x] T004 [P] [US1] Migrate `src/engine/planners/aider.ts` to use `createPlannerBase`: Keep `parseTokenUsage`, `parseKTokens`, `spawnAider`, `aiderAskArgs`. The `invokePlan` closes over config to pass model-specific args. `invokeEscalate` uses different args (code mode, `--no-auto-commits`). Remove duplicated boilerplate. Run `npm test` to verify.

- [x] T005 [P] [US1] Migrate `src/engine/planners/shell.ts` to use `createPlannerBase`: Keep `parseTextLine`, `parseJsonlLine`, `parseStreamJsonLine`, `getLineParser`, `spawnShellCommand`. Fix the dead ternary `r.isResult ? r.text : r.text` at line 74 → `r.text`. The `invokePlan` and `invokeEscalate` close over config command/args/format. Remove duplicated boilerplate. Run `npm test` to verify.

- [x] T006 [US1] Migrate `src/engine/planners/agent-sdk.ts` to use `createPlannerBase`: Keep `loadSdk`, `extractTextFromMessage`, `runQuery`. The `invokePlan` wraps `runQuery` returning `InvokeResult`. `escalateHintSuccess` override: `(r) => r.text.length > 0`. Remove duplicated boilerplate. Run `npm test` to verify.

- [x] T007 [US1] Migrate `src/engine/planners/claude-code.ts` to use `createPlannerBase`: Keep `spawnClaudePlanner`, `spawnClaudeEscalator`, stream parsing helpers. Use mutable `currentSessionId` in closure for session chaining across plan phases. Provide separate `invokePlan` (arg-based, session-aware) and `invokeEscalate` (stdin-based, no session). Override `escalateHintSuccess: () => false`. Override `escalateFullPostProcess` to write extracted code to disk via `writeFileSync`. Remove duplicated boilerplate. Run `npm test` to verify.

**Checkpoint**: All 6 planners use `createPlannerBase`. Each planner file is under 180 lines. `npm test && npm run build` passes. Total planner LOC reduced by ~40%.

---

## Phase 3: User Story 2 — Orchestrator Decomposition (Priority: P1)

**Goal**: Split `src/engine/orchestrator.ts` (908 lines) into 6 focused modules in `src/engine/orchestrator/` directory. No file exceeds 200 lines.

**Independent Test**: `npm test && npm run build` passes. All 4 consumer import paths updated. Workflow behavior identical.

### Implementation for User Story 2

- [x] T008 [P] [US2] Extract cost module at `src/engine/orchestrator/cost.ts`: Move `estimateCostSavings` (lines 139-143), `calculateCostBreakdown` (lines 145-183), and `buildSummary` (lines 886-908) from `src/engine/orchestrator.ts`. These are pure functions depending only on `TokenUsage`, `CostBreakdown`, `Summary` from `types.ts` and `getPricing`/`calculateCost` from `pricing.ts`. Export all three functions.

- [x] T009 [P] [US2] Extract token usage module at `src/engine/orchestrator/tokens.ts`: Move `addPlannerUsage` (lines 90-100), `addImplementerUsage` (lines 102-112), `addEscalationUsage` (lines 114-124), and `tokenDelta` (lines 126-135) from `src/engine/orchestrator.ts`. These are pure state-transformation functions operating on `WorkflowState.tokenUsage`. Export all four functions.

- [x] T010 [P] [US2] Extract helpers module at `src/engine/orchestrator/helpers.ts`: Move `supportsConversational` (lines 20-22), `persistClarifications` (lines 24-42), `buildContext` (lines 44-62), `emit` (lines 64-72), `emitValidationStart` (lines 74-79), `allValidationsPassed` (lines 81-83), `hasDependencyFailed` (lines 85-88) from `src/engine/orchestrator.ts`. Add NEW `emitValidationResult(callbacks, validationResults, startTime)` helper to replace the 4 duplicated ~10-line blocks (lines 574-583, 755-764, 820-829, 856-865). Export all functions.

- [x] T011 [P] [US2] Extract final review module at `src/engine/orchestrator/final-review.ts`: Move `runFinalReview` (lines 185-257) from `src/engine/orchestrator.ts`. It spawns `claude` CLI with `stream-json` output, parses via `parseStreamLine`, accumulates result text. Import `parseStreamLine` from `../claude-stream.js`, `spawnWithStreaming` from `../../utils/process.js`. Export `runFinalReview`.

- [x] T012 [US2] Extract task runner module at `src/engine/orchestrator/task-runner.ts`: Move `validateCommitAndAdvance` (lines 667-706) and `handleRetryAndEscalation` (lines 708-880) from `src/engine/orchestrator.ts`. Define `RetryResult` type locally. Import helpers from `./helpers.js`, token functions from `./tokens.js`, validator from `../validator.js`, implementer functions, git utilities. Replace inline `allValidationsPassed` logic (4 occurrences) with the helper from `helpers.ts`. Replace duplicated validation-event emission blocks with `emitValidationResult`. Export both functions.

- [x] T013 [US2] Create orchestrator index at `src/engine/orchestrator/index.ts` and delete original: Slim down `runWorkflow` to a high-level pipeline calling into extracted modules. Unify the duplicated spec/plan approval loops (lines 402-427 and 443-468) into a single `runApprovalLoop(type, planner, projectDir, config, callbacks, state)` function. Re-export public API: `runWorkflow`, `estimateCostSavings`, `calculateCostBreakdown`, `allValidationsPassed`, `hasDependencyFailed`. Delete `src/engine/orchestrator.ts`. Update imports in: `src/hooks/use-workflow.ts` (`../engine/orchestrator.js` → `../engine/orchestrator/index.js`), `tests/orchestrator.test.ts`, `tests/summary.test.ts`, `tests/integration/tokens.integration.test.ts`. Run `npm test && npm run build` to verify.

**Checkpoint**: Orchestrator directory contains 6 files, each under 200 lines. `npm test && npm run build` passes. 4 consumer imports updated.

---

## Phase 4: User Story 3 — Implementer Cleanup (Priority: P2)

**Goal**: Extract `applyCode` and `streamCompletion` into standalone modules. Unify implement/retry duplication. Eliminate upward dependency from `implementers/shell.ts`.

**Independent Test**: `npm test && npm run build` passes. No implementer sub-module imports from parent. `implementTask`/`retryTask` public API unchanged.

### Implementation for User Story 3

- [x] T014 [P] [US3] Extract apply-code module at `src/engine/apply.ts`: Move `applyCode` function (lines 12-71) from `src/engine/implementer.ts` into new file. Import `Task` from `../types.js`, `validateTaskPath` from `../utils/fs.js`, `existsSync`/`readFileSync`/`writeFileSync`/`mkdirSync` from `node:fs`. Update import in `src/engine/implementer.ts` to `import { applyCode } from './apply.js'`. Update import in `src/engine/implementers/shell.ts` from `'../implementer.js'` to `'../apply.js'`. Update import in `tests/implementer.test.ts`. Export `applyCode`. Run `npm test` to verify.

- [x] T015 [P] [US3] Extract OpenAI stream module at `src/engine/openai-stream.ts`: Move `streamCompletion` function (lines 78-163) and `CompletionResult` interface from `src/engine/implementer.ts` into new file. Import `Config` from `../types.js`, OpenAI types. Update import in `src/engine/implementer.ts` to `import { streamCompletion, CompletionResult } from './openai-stream.js'`. Export both. Run `npm test` to verify.

- [x] T016 [US3] Deduplicate implement/retry in `src/engine/implementer.ts`: Create internal `runOpenAIImplementer(params)` function that contains the shared logic (file reading, client creation, streaming, code extraction, code application, diff computation, event emission). Reduce `implementTask` and `retryTask` to thin wrappers that differ only in prompt construction (`formatTaskPrompt` vs `formatRetryPrompt`) and temperature calculation (base vs `base + attempt * 0.1`). Remove 6 occurrences of `?? undefined` defensive pattern (convert upstream type or accept null). Run `npm test` to verify.

- [x] T017 [US3] Deduplicate implement/retry in `src/engine/implementers/shell.ts`: Create internal `runShellImplementer(task, projectDir, config, prompt, onProgress)` function with the shared spawn + extract + apply + return logic. Reduce `implementTaskViaShell` and `retryTaskViaShell` to thin wrappers that differ only in prompt string. Run `npm test` to verify.

**Checkpoint**: Upward dependency eliminated. `implementer.ts` down from 307 to ~120 lines. `npm test && npm run build` passes.

---

## Phase 5: User Story 4 — Dead Code & Slop Removal (Priority: P2)

**Goal**: Delete all dead exports, remove unnecessary comments, fix type slop. Every line of code serves a purpose.

**Independent Test**: `npm test && npm run build` passes. Zero dead exports. Zero unnecessary comments. Zero `catch (err: any)`.

### Implementation for User Story 4

- [x] T018 [P] [US4] Delete dead code files and functions: Delete `src/engine/escalator.ts` (22 lines, zero callers). Remove `detectLocalModels()` function (lines 26-57) from `src/engine/providers.ts` (exported but never imported). Remove dead `codeContext = 0` field from `computeTokenBudget` in `src/engine/spec/formatter.ts` (line 54, never filled by any caller). Remove unused `isMedium` and `isLarge` return values from `src/hooks/use-terminal-size.ts` (lines 34-35, zero consumers). Run `npm test` to verify.

- [x] T019 [P] [US4] Fix type slop across engine files: Change `catch (err: any)` to `catch (err: unknown)` with proper type narrowing in `src/engine/validator.ts` (lines 107, 133, 171 — match the pattern at line 76 which already does it correctly). Remove `as any` casts in `src/hooks/use-config.ts` (lines 17-18) — use `config.planner.tool = overrides.plannerOverride as PlannerTool` instead. Run `npm test` to verify.

- [x] T020 [P] [US4] Remove unnecessary comments across `src/engine/`: Delete ~25 comments that restate what the code does. Key targets: `implementer.ts` lines 44, 45, 68 (fallback comments). `spec/formatter.ts` lines 75, 81, 98, 103, 148, 150, 164, 173, 175. `spec/parser.ts` line 152. `providers.ts` line 102. `detection.ts` line 49. `implementers/agent.ts` lines 31, 39. Orchestrator comments will already be handled during US2 decomposition — only touch files NOT modified by US2. Run `npm test` to verify.

- [x] T021 [P] [US4] Fix redundant types and imports in UI files: In `src/ui/summary.tsx`: delete local `TaskTokenUsage` interface (lines 6-13), delete local `CostBreakdown` interface (lines 15-23), delete `ExtendedSummary` type (lines 25-30) — import `TaskTokenUsage`, `CostBreakdown`, `Summary` from `../types.js` instead and use `Summary` directly (it already has all fields). Run `npm test` to verify.

**Checkpoint**: Zero dead exports. Zero unnecessary comments in engine/. Zero `catch (err: any)`. `npm test && npm run build` passes.

---

## Phase 6: User Story 5 — React Anti-Pattern Fixes (Priority: P3)

**Goal**: Fix render-phase side effects, derive-don't-sync violations, and sync I/O without memoization in hooks.

**Independent Test**: `npm test` passes. TUI screens render correctly (manual verification). No component calls callbacks during render.

### Implementation for User Story 5

- [x] T022 [P] [US5] Fix render-phase side effects in `src/ui/picker.tsx`: Move `onError()` call (line 26) into a `useEffect` with `[availablePlanners.length]` dependency. Move the auto-select logic (lines 34-42, `setSelectedPlanner`/`setStep` during render) into a `useEffect`. Move `onComplete()` calls (lines 53-55, 119-121) into `useEffect` hooks. Verify picker still works correctly for init flow.

- [x] T023 [P] [US5] Fix `src/hooks/use-config.ts` memoization: Wrap the `loadConfig` call and override application in `useMemo` with dependencies `[projectDir, overrides.modelOverride, overrides.providerOverride, overrides.contextLengthOverride, overrides.plannerOverride, overrides.plannerModelOverride]`. Remove `as any` casts (already covered by T019 but verify). This prevents sync file I/O on every render.

- [x] T024 [P] [US5] Fix derive-don't-sync in `src/hooks/use-skills.ts`: Replace `useEffect` + `setState` pattern (lines 9-12) with `useMemo` for `available`: `const available = useMemo(() => discoverSkills(plannerTool, projectDir), [plannerTool, projectDir])`. Keep `selected` as separate `useState`. Remove the `useEffect` entirely.

- [x] T025 [P] [US5] Fix `src/ui/input-bar.tsx` prevValue pattern: Remove the `prevValue`/`setPrevValue` state and the render-time setState (lines 43-47). Instead, reset `selectedIndex` to 0 directly in the `useInput` callback wherever `setValue` is called (the backspace handler and the character input handler).

- [x] T026 [P] [US5] Fix `src/ui/review-view.tsx` sync I/O and derive-don't-sync: Replace `useEffect` with `readFileSync` (lines 50-56) with a lazy `useState` initializer: `useState(() => existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ...)`. Remove the `prevExternalOffset`/`setPrevExternalOffset` pattern (lines 48-61) — make the component fully uncontrolled with `key={filePath}` on the parent side for reset.

**Checkpoint**: No render-phase side effects. All hooks properly memoized. `npm test` passes.

---

## Phase 7: User Story 6 — UI Deduplication (Priority: P3)

**Goal**: Canonical single-source utilities for `truncate` and markdown rendering. Remove unused imports.

**Independent Test**: `npm test && npm run build` passes. `truncate` exists in exactly 1 file. `renderMarkdownLine` exists in exactly 1 file.

### Implementation for User Story 6

- [x] T027 [P] [US6] Deduplicate `truncate` function: Delete the local `truncate` function from `src/ui/header.tsx` (line 22) and `src/ui/sidebar.tsx` (line 40). Add `import { truncate } from './picker-utils.js'` to both files. Verify the canonical `truncate` in `src/ui/picker-utils.ts` has the same signature `(text: string, max: number) => string`.

- [x] T028 [P] [US6] Create shared markdown renderer at `src/ui/markdown.tsx`: Extract `parseBlocks`, `renderMarkdownLine`, `HighlightedCode`, and `PlannerText` from `src/ui/event-card.tsx` (lines 15-128) into the new file. Make `renderMarkdownLine` accept a `Theme` parameter (unifying the two divergent copies). Update `src/ui/event-card.tsx` to import from `./markdown.js`. Update `src/ui/review-view.tsx` to import the shared `renderMarkdownLine` from `./markdown.js` and delete its local copy (lines 13-37).

- [x] T029 [P] [US6] Remove unused `import React` from 3 UI files: Remove `import React from 'react'` from `src/ui/help-overlay.tsx` (line 1), `src/ui/slash-suggestions.tsx` (line 1). In `src/ui/command-palette.tsx` (line 1), change `import React, { useState } from 'react'` to `import { useState } from 'react'`. These files use JSX but with `react-jsx` transform, `React` is not needed in scope.

**Checkpoint**: `truncate` in 1 file. `renderMarkdownLine` in 1 file. Zero unused React imports. `npm test && npm run build` passes.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and documentation updates

- [x] T030 Verify all success criteria from spec: Run `npm test && npm run build`. Verify no `src/engine/` file exceeds 200 lines (use `wc -l`). Verify total planner LOC reduced by 40%+. Verify zero dead exports via grep. Verify zero `catch (err: any)` via grep. Verify zero duplicated `truncate`/`renderMarkdownLine` via grep.

- [x] T031 Update CLAUDE.md project structure section to reflect new file layout: Update the `src/engine/` tree to show `orchestrator/` directory, `apply.ts`, `openai-stream.ts`, `planners/base.ts`. Remove `escalator.ts` from the tree. Update any line counts that are documented.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: Empty — no blocking prerequisites
- **Phase 2 (US1 - Planners)**: Can start immediately
- **Phase 3 (US2 - Orchestrator)**: Can start immediately, parallel with Phase 2
- **Phase 4 (US3 - Implementer)**: Can start immediately, parallel with Phases 2-3
- **Phase 5 (US4 - Dead Code)**: Depends on Phases 2, 3, 4 (touches files modified by US1-US3)
- **Phase 6 (US5 - React Fixes)**: Can start after Phase 3 (US2 touches orchestrator which is used by hooks)
- **Phase 7 (US6 - UI Dedup)**: Can start after Phase 5 (US4 modifies summary.tsx)
- **Phase 8 (Polish)**: Depends on all previous phases

### User Story Dependencies

- **US1 (Planners)**: No dependencies — standalone in `src/engine/planners/`
- **US2 (Orchestrator)**: No dependencies — standalone in `src/engine/orchestrator.ts`
- **US3 (Implementer)**: No dependencies — standalone in `src/engine/implementer*.ts`
- **US4 (Dead Code)**: Depends on US1, US2, US3 (avoids editing files being restructured)
- **US5 (React Fixes)**: Depends on US2 (orchestrator import paths change)
- **US6 (UI Dedup)**: Depends on US4 (summary.tsx types fixed first)

### Within Each User Story

- T001 must complete before T002-T007 (base module must exist before migration)
- T002-T005 can run in parallel (codex, opencode, aider, shell are independent)
- T006 can run in parallel with T002-T005
- T007 can run in parallel with T002-T006
- T008-T011 can run in parallel (leaf modules: cost, tokens, helpers, final-review)
- T012 depends on T010 (task-runner uses helpers)
- T013 depends on T008-T012 (index assembles all modules)
- T014-T015 can run in parallel (apply.ts and openai-stream.ts are independent)
- T016 depends on T014, T015 (implementer uses both extracted modules)
- T017 depends on T014 (shell uses apply.ts)

### Parallel Opportunities

```
Batch 1 (3 parallel agents):
  Agent A: T001 → T002, T003, T004, T005 (parallel) → T006 → T007
  Agent B: T008, T009, T010, T011 (parallel) → T012 → T013
  Agent C: T014, T015 (parallel) → T016 → T017

Batch 2 (3 parallel agents, after Batch 1):
  Agent D: T018, T019, T020, T021 (all parallel)
  Agent E: T022, T023, T024, T025, T026 (all parallel)
  Agent F: T027, T028, T029 (all parallel)

Batch 3 (sequential):
  T030, T031
```

---

## Parallel Example: User Story 1 (Planner Base)

```bash
# First: create the base module (must complete first)
Task T001: "Create shared planner base module at src/engine/planners/base.ts"

# Then: migrate all 6 planners in parallel
Task T002: "Migrate src/engine/planners/codex.ts to use createPlannerBase"
Task T003: "Migrate src/engine/planners/opencode.ts to use createPlannerBase"
Task T004: "Migrate src/engine/planners/aider.ts to use createPlannerBase"
Task T005: "Migrate src/engine/planners/shell.ts to use createPlannerBase"
Task T006: "Migrate src/engine/planners/agent-sdk.ts to use createPlannerBase"
Task T007: "Migrate src/engine/planners/claude-code.ts to use createPlannerBase"
```

---

## Parallel Example: User Story 2 (Orchestrator)

```bash
# First: extract all leaf modules in parallel
Task T008: "Extract cost module at src/engine/orchestrator/cost.ts"
Task T009: "Extract token usage module at src/engine/orchestrator/tokens.ts"
Task T010: "Extract helpers module at src/engine/orchestrator/helpers.ts"
Task T011: "Extract final review module at src/engine/orchestrator/final-review.ts"

# Then: task-runner (depends on helpers + tokens)
Task T012: "Extract task runner module at src/engine/orchestrator/task-runner.ts"

# Finally: index (depends on all above)
Task T013: "Create orchestrator index + delete original + update imports"
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 2: US1 — Planner Base Extraction
2. Complete Phase 3: US2 — Orchestrator Decomposition
3. **STOP and VALIDATE**: `npm test && npm run build`. Verify biggest files are gone.
4. This alone eliminates ~1,100 LOC of duplication and splits the 908-line orchestrator.

### Incremental Delivery

1. US1 + US2 → Validate → Core structural refactoring done (MVP)
2. US3 → Validate → Implementer layer clean
3. US4 → Validate → Dead code eliminated
4. US5 → Validate → React patterns correct
5. US6 → Validate → UI fully deduplicated
6. Each story adds quality without breaking previous work

### Parallel Agent Strategy

With 6+ Opus agents:

1. **Batch 1** (3 agents, parallel — largest impact):
   - Agent A: US1 (Planners) — T001 through T007
   - Agent B: US2 (Orchestrator) — T008 through T013
   - Agent C: US3 (Implementer) — T014 through T017
2. **Batch 2** (3 agents, parallel — cleanup):
   - Agent D: US4 (Dead Code) — T018 through T021
   - Agent E: US5 (React Fixes) — T022 through T026
   - Agent F: US6 (UI Dedup) — T027 through T029
3. **Batch 3** (1 agent, sequential):
   - T030 (verification) and T031 (docs update)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable via `npm test && npm run build`
- Commit after each task — each task is a self-contained, verifiable change
- No new test files needed — this is pure structural refactoring
- If any test fails after a task, fix the test (import paths) within that task
- The `PlannerBackend` interface in `types.ts` is NOT modified — all changes are internal
