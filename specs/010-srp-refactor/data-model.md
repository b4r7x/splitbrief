# Data Model: SRP Refactoring

**Date**: 2026-03-28

## Overview

This refactoring does not introduce new domain entities. It reorganizes existing types across domain-specific modules and introduces two structural types (`WorkflowContext`, shared validation/action types). No state transitions change. No data flows change. Only file locations and import paths change.

## Type Module Layout

### `src/types/core.ts` — Foundational types (Level 0, no dependencies)

| Type | Kind | Fields/Members | Used by |
|------|------|---------------|---------|
| `Phase` | string union | 12 members: idle, researching, specifying, reviewing-spec, planning, reviewing-plan, review-gate, implementing, validating-task, escalating, final-review, complete | state.ts, tui/, app.tsx, orchestrator |
| `PermissionMode` | string union | supervised, normal, auto, plan-only | config.ts, cli.ts, tui/, app.tsx, orchestrator |
| `TaskStatus` | string union | pending, in-progress, done, failed, skipped | Task.status |
| `PlannerTool` | string union | claude-code, codex, opencode, aider, agent-sdk, shell | config.ts, planners/, orchestrator |
| `OutputFormat` | string union | stream-json, jsonl, text | Config, planners/shell, implementers/shell |
| `Task` | interface | 15 fields: id, title, action, file, dependsOn, description, signature?, currentCode?, tests, constraints, pattern?, typeDefs, implSteps, status | 16 consumer files |
| `Config` | interface | 4 sections: planner, implementer, validation, workflow | 13 consumer files |
| `ProjectContext` | interface | name, dir, runtime, testCommand | 6 consumer files |

### `src/types/validation.ts` — Metrics and results (Level 0, no dependencies)

| Type | Kind | Fields | Used by |
|------|------|--------|---------|
| `ValidationResult` | interface | stage, passed, error?, output? | validator.ts, orchestrator |
| `ValidationStages` | interface | **NEW** — tsc: boolean, lint: boolean, test: boolean | task-result.tsx, OrchestratorCallbacks, TuiEvent |
| `TokenUsage` | interface | planner, implementer, escalation (each: prompt, completion, total) | state.ts, orchestrator, summary.tsx |
| `TaskTokenUsage` | interface | taskId, method, tokens, duration, retries | orchestrator |
| `CostBreakdown` | interface | hypotheticalCost, actualCost, saved, savingsPercent, localRate | orchestrator |
| `Summary` | interface | feature, tasks (total/completed/escalated/failed/skipped), duration, tokenUsage, taskBreakdowns, costBreakdown | orchestrator, app.tsx, summary.tsx |

### `src/types/spec.ts` — Spec formatting (Level 0, no dependencies)

| Type | Kind | Fields | Used by |
|------|------|--------|---------|
| `TokenBudget` | interface | contextWindow, outputReserve, systemTokens, availableForContext | spec/formatter.ts |
| `CodeContext` | discriminated union | mode: whole-file / function-level / truncated / error | spec/formatter.ts |

### `src/types/tui.ts` — TUI event system (Level 1, depends on core.ts + validation.ts)

| Type | Kind | Fields | Used by |
|------|------|--------|---------|
| `TldrChangeset` | interface | added?, changed?, removed?, summary | tldr-parser.ts, changes-card.tsx |
| `TaskSummaryInfo` | type alias | **NEW** — Pick<Task, 'id' \| 'title' \| 'action' \| 'file'> | review-gate.tsx, TuiEvent, OrchestratorCallbacks |
| `TaskPreviewAction` | string union | **NEW** — 'proceed' \| 'skip' | task-preview.tsx, OrchestratorCallbacks |
| `TaskReviewAction` | string union | **NEW** — 'commit' \| 'retry' \| 'skip' \| 'edit' | task-result.tsx, OrchestratorCallbacks |
| `TuiEvent` | discriminated union | 15+ event types (planner-status, planner-text, task-start, task-complete, validate, implementer-generate, escalate, error, commit, diff, review-gate, tldr-changeset, mode-change, etc.) | orchestrator, implementer.ts, app.tsx, tui/ |
| `OrchestratorCallbacks` | interface | onEvent, onApprovalNeeded, onExternalChanges, onComplete, onQuestionAsked?, onReviewGate?, onTaskApproval?, onTaskReview? | orchestrator, app.tsx |

### `src/types/state.ts` — State machine (Level 1, depends on core.ts + validation.ts)

| Type | Kind | Fields | Used by |
|------|------|--------|---------|
| `WorkflowState` | interface | phase, feature, tasks, currentTaskIndex, tokenUsage, startedAt, stateVersion, permissionMode, etc. | state.ts, orchestrator, app.tsx |
| `StateAction` | discriminated union | 24 action types (START, RESEARCH_DONE, SPEC_DONE, ..., SET_MODE, BACK_TO_SPEC, etc.) | state.ts |
| `Event` | interface | type, phase, timestamp, data? | state.ts |

## New Structural Types

### `WorkflowContext` (in `src/types/orchestrator.ts` or locally in orchestrator modules)

Bundles immutable session parameters for extracted orchestrator functions:

| Field | Type | Source |
|-------|------|--------|
| feature | string | runWorkflow param |
| projectDir | string | runWorkflow param |
| config | Config | runWorkflow param |
| callbacks | OrchestratorCallbacks | runWorkflow param |
| startTime | number | Date.now() at workflow start |
| planner | PlannerBackend | createPlanner(config) result |
| projectContext | ProjectContext | buildContext(projectDir) result |

Created once at workflow start, never mutated.

### Shared Type Aliases (deduplication)

| Name | Definition | Replaces |
|------|-----------|----------|
| `TaskSummaryInfo` | `Pick<Task, 'id' \| 'title' \| 'action' \| 'file'>` | Inline `{ id: string; title: string; action: string; file: string }` in 3 locations |
| `ValidationStages` | `{ tsc: boolean; lint: boolean; test: boolean }` | Inline validation shape in 3 locations |
| `TaskPreviewAction` | `'proceed' \| 'skip'` | `'implement' \| 'skip'` in task-preview (unified vocabulary) |
| `TaskReviewAction` | `'commit' \| 'retry' \| 'skip' \| 'edit'` | Inline union in task-result (minus `'diff'` which is UI-only) |

## Migration Strategy

No data migration needed. This is a pure code reorganization:

1. Types move from `src/types.ts` to `src/types/*.ts` subfiles
2. Every import path `'../types.js'` → `'../types/core.js'`, `'../types/tui.js'`, etc.
3. Inline type definitions → shared named types
4. No runtime behavior changes
5. All 512 tests continue to pass with updated import paths
