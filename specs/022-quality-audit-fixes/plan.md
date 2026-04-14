# Implementation Plan: Code Quality Audit Remediation

**Branch**: `022-quality-audit-fixes` | **Date**: 2026-04-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/022-quality-audit-fixes/spec.md`

## Summary

Systematic remediation of 18 BLOCKERs, 7 DRY violation patterns, 7 type design issues, React anti-patterns, dead code, and test quality issues identified by 20 parallel Opus code quality agents across 91 source files. All changes are internal refactoring — no new features, no user-facing behavior changes except bug fixes (review scroll, OpenRouter pricing, race conditions).

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)  
**Primary Dependencies**: Ink 6.x (React 19), openai ^6.0, simple-git, commander ^14.0, yaml, Shiki 4.x, ansis  
**Storage**: JSON files (`.diptych/state.json`, `events.jsonl`), Markdown files  
**Testing**: Node.js test runner (`node --test`) with `tsx` loader  
**Target Platform**: macOS (primary), Linux (secondary)  
**Project Type**: CLI tool (TUI via Ink)  
**Performance Goals**: N/A (internal refactoring)  
**Constraints**: All 470 existing tests must pass after every change, zero React/Ink in engine/utils  
**Scale/Scope**: 91 files, 9,141 lines, 40 functional requirements across 6 user stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Internal refactoring, no token cost impact. Fixes OpenRouter pricing accuracy. |
| II. Spec-Driven Development | PASS | Following speckit workflow: specify → plan → tasks → implement. |
| III. Local-First Implementation | PASS | No changes to local-first architecture. |
| IV. Functional Purity | PASS | Reinforces: removes dead code, eliminates `?? undefined` no-ops, enforces `.js` extensions, removes unnecessary comments. Zero classes. |
| V. Validate Before Commit | PASS | Tests must pass after every task. tsc + lint + test pipeline unchanged. |
| VI. Identity & Anti-Goals | PASS | No new features, no multi-agent architecture changes. Pure quality improvement. |

No violations. No complexity justification needed.

## Project Structure

### Documentation (this feature)

```text
specs/022-quality-audit-fixes/
├── plan.md              # This file
├── research.md          # Phase 0: 5 research topics resolved
├── data-model.md        # Phase 1: entity relationships for the refactoring
├── quickstart.md        # Phase 1: execution guide
├── checklists/
│   └── requirements.md  # Spec quality validation
└── tasks.md             # Phase 2 output (from /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── engine/
│   ├── orchestrator/
│   │   ├── index.ts          # FR-009: extract initializeWorkflow, runFinalReviewPhase
│   │   ├── planning.ts       # FR-009: extract collectAndPersistClarifications
│   │   ├── task-loop.ts      # FR-009: extract checkExternalChanges, handleSkippedTask
│   │   ├── task-runner.ts    # FR-010: keep validateCommitAndAdvance only
│   │   ├── escalation.ts     # FR-010: NEW — tier-0/1/2 escalation cascade
│   │   ├── events.ts         # FR-016: add createTextHandler shared helper
│   │   ├── cost.ts           # FR-026: receive BuildSummaryState from types.ts
│   │   ├── helpers.ts        # (unchanged)
│   │   └── tokens.ts         # FR-023: simplify addUsage after token unification
│   ├── planners/
│   │   ├── spawn.ts          # FR-017: add spawnAndCollect shared function
│   │   └── *.ts              # FR-017: refactor to use spawnAndCollect
│   ├── implementers/
│   │   ├── agent.ts          # FR-014: extract interpretAgentResult
│   │   └── shell.ts          # FR-019, FR-023: use implementer-utils, remove toImplUsage
│   ├── implementer.ts        # FR-019: extract shared fns to implementer-utils.ts
│   ├── implementer-utils.ts  # FR-019: NEW — createGenEventEmitter, processImplementerOutput
│   ├── providers.ts          # FR-020, FR-034, FR-035: receive DEFAULT_BASES, type responses
│   ├── pricing.ts            # FR-005: add OpenRouter pricing
│   ├── detection.ts          # FR-034: type API responses
│   ├── skills.ts             # FR-032: unexport parseFrontmatter, loadSkillContent
│   ├── question-parser.ts    # FR-026: canonical ClarificationQuestion source
│   └── spec/
│       ├── templates.ts      # FR-007: barrel re-export only (~10 lines)
│       ├── planning-prompts.ts # FR-007: NEW — research/spec/plan/regen/tasks prompts
│       ├── execution-prompts.ts # FR-007: NEW — hint/escalation prompts
│       ├── review-prompts.ts # FR-007: NEW — final review prompt
│       └── parser.ts         # FR-026: receive TaskFrontmatter from types.ts
├── hooks/
│   ├── use-config.ts         # FR-001: throw instead of process.exit
│   ├── use-input-mode.ts     # FR-002: capture mode before setModeState
│   ├── use-workflow.ts       # FR-011: use refs for closure-captured values
│   ├── use-overlay.ts        # FR-028: add useCallback
│   ├── use-sidebar.ts        # FR-028: add useCallback
│   └── use-router.ts         # FR-028: add useCallback
├── ui/
│   ├── input-bar.tsx         # FR-003, FR-018: single source of truth, lookup for placeholder
│   ├── review-view.tsx       # FR-004: implement scroll state
│   ├── skills-picker.tsx     # FR-008: decompose god component
│   ├── event-card.tsx        # FR-013, FR-029: fix JSX.Element, extract Spinner
│   ├── spinner.tsx           # FR-029: NEW — extracted from event-card
│   ├── markdown.tsx          # FR-027: fix bold/italic interaction
│   ├── picker.tsx            # FR-012: DELETE
│   └── event-sections.ts     # FR-030: unexport getVisibleWindow (in utils/)
├── utils/
│   ├── errors.ts             # FR-015: NEW — toErrorMessage utility
│   ├── fs.ts                 # FR-018: add readFileOrEmpty
│   ├── process.ts            # FR-006: encapsulate activeProcesses
│   └── event-sections.ts     # FR-030: unexport dead exports
├── types.ts                  # FR-020-026: move DEFAULT_BASES, export TaskStatus, 
│                             #   rename Event→OrchestratorEvent, unify token types,
│                             #   colocate single-consumer types, dedup SidebarTask
├── cli.ts                    # FR-031: remove section dividers
└── state.ts                  # FR-025: update Event→OrchestratorEvent import

tests/
├── helpers/
│   ├── fixtures.ts           # FR-039: ensure makeTask is the single factory
│   └── react-tree.ts         # FR-038: NEW — shared collectText/findText
├── events.test.ts            # FR-036: rewrite for behavior testing
├── diff-view.test.ts         # FR-037: rewrite for actual component
├── cost-footer.test.ts       # FR-038: use shared react-tree helpers
├── event-card.test.ts        # FR-038: use shared react-tree helpers
├── openai-stream.test.ts     # FR-023: update token field assertions
├── state.test.ts             # FR-039: use shared makeTask
└── integration/
    ├── resume.integration.test.ts  # FR-039: use shared makeTask
    └── retry.integration.test.ts   # FR-039: use shared makeTask
```

**Structure Decision**: This is a refactoring within the existing project structure. No new directories are created. New files are added alongside their related modules: `escalation.ts` in `orchestrator/`, `implementer-utils.ts` in `engine/`, `spinner.tsx` in `ui/`, `errors.ts` in `utils/`, split template files in `spec/`, and `react-tree.ts` in `tests/helpers/`.

## Execution Phases

The 40 FRs are organized into 8 execution phases. Each phase is independently testable (`npm test` must pass after every phase). Phases are ordered to minimize cascading changes — type/utility changes first, then consumers.

### Phase 1: Foundation — Types, Utils, Dead Code (FR-015, FR-018, FR-020-026, FR-006, FR-012, FR-025, FR-030-033, FR-035)

**Goal**: Establish the type and utility foundation that all other phases depend on.

**Tasks**:
1. Create `utils/errors.ts` with `toErrorMessage()` (FR-015 — utility only, consumers in Phase 5)
2. Add `readFileOrEmpty()` to `utils/fs.ts` (FR-018 — utility only, consumers in Phase 5)
3. Encapsulate `activeProcesses` in `utils/process.ts` (FR-006)
4. Move `DEFAULT_BASES` from `types.ts` to `engine/providers.ts`, update imports (FR-020, FR-035)
5. Export `TaskStatus` from `types.ts` (FR-021)
6. Rename `Event` to `OrchestratorEvent` in `types.ts` and `state.ts` (FR-025)
7. Unify `ImplementerTokenUsage` fields to `inputTokens`/`outputTokens` (FR-023)
8. Type `TuiEvent.planner-status.phase` as `Phase` (FR-024)
9. Deduplicate `SidebarTask` — single definition in `types.ts`, import in `ui/sidebar.tsx` and `hooks/use-workflow.ts` (FR-022)
10. Colocate single-consumer types: `TaskFrontmatter` → `parser.ts`, `BuildSummaryState` → `cost.ts`, `ClarificationQuestion` → `question-parser.ts` (FR-026)
11. Delete `ui/picker.tsx` (FR-012)
12. Remove dead exports: `getVisibleWindow`, `estimateEventHeight` from `event-sections.ts`, `TuiEventType` from `types.ts` (FR-030)
13. Remove `?? undefined` no-ops (FR-033)
14. Remove unnecessary exports from `skills.ts` (FR-032)
15. Remove section divider comments from `cli.ts` (FR-031)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 2: Engine DRY Consolidation (FR-016, FR-017, FR-019)

**Goal**: Create shared utilities that eliminate duplicated patterns in the engine layer.

**Tasks**:
1. Extract `createGenEventEmitter` and `processImplementerOutput` from `implementer.ts` to new `implementer-utils.ts` (FR-019 — breaks circular dep)
2. Update `implementer.ts` and `implementers/shell.ts` to import from `implementer-utils.ts` (FR-019)
3. Add `spawnAndCollect()` to `planners/spawn.ts` (FR-017)
4. Refactor planner backends (codex, opencode, shell, aider) to use `spawnAndCollect()` (FR-017)
5. Add `createTextHandler()` to `orchestrator/events.ts` (FR-016)
6. Replace 7 inline text handler patterns with `createTextHandler()` across orchestrator modules (FR-016)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 3: Orchestrator Decomposition (FR-009, FR-010)

**Goal**: Break down oversized orchestrator functions into readable helpers.

**Tasks**:
1. Extract `initializeWorkflow()` and `runFinalReviewPhase()` in `orchestrator/index.ts` (FR-009)
2. Extract `collectAndPersistClarifications()` in `orchestrator/planning.ts` (FR-009)
3. Extract `checkExternalChanges()` and `handleSkippedTask()` in `orchestrator/task-loop.ts` (FR-009)
4. Create `orchestrator/escalation.ts` with tier-0/1/2 functions from `task-runner.ts` (FR-010)
5. Update `task-loop.ts` imports: `handleRetryAndEscalation` from `escalation.ts` (FR-010)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 4: Template Split + Agent Decomposition (FR-007, FR-014)

**Goal**: Split oversized template file and decompose agent implementer.

**Tasks**:
1. Create `spec/planning-prompts.ts` with 5 planning functions (FR-007)
2. Create `spec/execution-prompts.ts` with 2 execution functions (FR-007)
3. Create `spec/review-prompts.ts` with 1 review function (FR-007)
4. Convert `templates.ts` to barrel re-export (FR-007)
5. Extract `interpretAgentResult()` from `agent.ts:runAgentImplementer` (FR-014)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 5: DRY Consumer Updates (FR-015, FR-018 consumers)

**Goal**: Replace all inline duplicated patterns with the shared utilities created in earlier phases.

**Tasks**:
1. Replace 8 inline error extraction patterns with `toErrorMessage()` (FR-015)
2. Replace 3 inline file-read-with-fallback patterns with `readFileOrEmpty()` (FR-018)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 6: Critical Runtime Fixes (FR-001 through FR-005)

**Goal**: Fix the 5 runtime bugs identified in User Story 1.

**Tasks**:
1. Replace `process.exit(2)` with throw in `hooks/use-config.ts` (FR-001)
2. Capture mode before state reset in `hooks/use-input-mode.ts` (FR-002)
3. Single source of truth in `ui/input-bar.tsx` — pre-filter items, eliminate sync effects (FR-003)
4. Implement scroll state in `ui/review-view.tsx` (FR-004)
5. Add OpenRouter pricing to `engine/pricing.ts` (FR-005)

**Verification**: `npm test` + manual TUI smoke test

### Phase 7: React Pattern Fixes (FR-008, FR-013, FR-027-029, FR-034)

**Goal**: Fix React anti-patterns, extract components, improve hooks.

**Tasks**:
1. Extract `Spinner` component to `ui/spinner.tsx` (FR-029)
2. Fix `React.JSX.Element` → `JSX.Element` in `event-card.tsx` (FR-013)
3. Fix bold/italic interaction in `markdown.tsx` (FR-027)
4. Add `useCallback` to `use-overlay.ts`, `use-sidebar.ts`, `use-router.ts` (FR-028)
5. Decompose `skills-picker.tsx` — extract scroll/toggle logic (FR-008)
6. Replace `as any` with typed interfaces in `providers.ts` and `detection.ts` (FR-034)
7. Use refs for stale closure risk in `hooks/use-workflow.ts` (FR-011)

**Verification**: `npm test` + `npx tsc --noEmit`

### Phase 8: Test Quality (FR-036 through FR-040)

**Goal**: Improve test suite by fixing misleading tests and deduplicating helpers.

**Tasks**:
1. Extract `collectText`/`findText` to `tests/helpers/react-tree.ts` (FR-038)
2. Update `cost-footer.test.ts` and `event-card.test.ts` to use shared helpers (FR-038)
3. Consolidate `makeTask` factories — update `state.test.ts`, `resume.integration.test.ts`, `retry.integration.test.ts` (FR-039)
4. Rewrite `tests/events.test.ts` for behavior testing (FR-036)
5. Rewrite `tests/diff-view.test.ts` for actual component testing (FR-037)
6. Remove orphaned `filterCommands` and `filterSkills` exports (FR-040)

**Verification**: `npm test` — all tests pass with improved quality

## Multi-Agent Execution Strategy

This plan is designed for parallel execution by multiple agents. The 8 phases have the following dependency graph:

```
Phase 1 (Foundation) ──→ Phase 2 (DRY Consolidation) ──→ Phase 3 (Orchestrator)
                    ├──→ Phase 4 (Templates + Agent)
                    ├──→ Phase 5 (DRY Consumers) ← depends on Phase 2 utilities
                    ├──→ Phase 6 (Runtime Fixes)
                    └──→ Phase 7 (React Patterns)
                                                          Phase 8 (Tests) ← after all others
```

**Parallelizable groups** (after Phase 1 completes):
- Group A: Phase 2 + Phase 4 + Phase 6 (independent engine/UI changes)
- Group B: Phase 3 (depends on Phase 2 for `createTextHandler`)
- Group C: Phase 5 (depends on Phase 2 for `toErrorMessage`/`readFileOrEmpty`)
- Group D: Phase 7 (independent React/UI changes)
- Group E: Phase 8 (must run last)

Recommended agent allocation: 5-8 agents for Phase 1 (most tasks are independent file edits), 3-4 agents for the parallel Phase 2/4/6 group, 2 agents for Phase 3, 2 agents for Phase 5/7, 1 agent for Phase 8.
