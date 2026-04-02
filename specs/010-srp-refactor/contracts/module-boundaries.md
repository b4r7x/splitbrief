# Module Boundary Contracts: SRP Refactoring

**Date**: 2026-03-28

## Import Graph Contract

After refactoring, the module dependency graph MUST follow this layered structure. Arrows indicate "depends on" (imports from).

```
Level 0 (no dependencies):
  src/types/core.ts
  src/types/validation.ts
  src/types/spec.ts

Level 1 (depends only on Level 0):
  src/types/tui.ts         → core, validation
  src/types/state.ts       → core, validation

Level 2 (depends on Level 0-1):
  src/state.ts             → types/core, types/validation, types/state
  src/config.ts            → types/core

Level 3 (depends on Level 0-2):
  src/spec/*               → types/core, types/spec
  src/utils/*              → (node builtins only)
  src/orchestrator/planners/* → types/core, utils/*, spec/*
  src/orchestrator/implementers/* → types/core, utils/*

Level 4 (depends on Level 0-3):
  src/orchestrator/cost.ts            → types/core, types/validation, orchestrator/pricing
  src/orchestrator/approval-loop.ts   → types/core, types/tui, types/state, state, spec/*, utils/*
  src/orchestrator/retry-escalation.ts → types/core, types/validation, types/tui, implementer, validator, escalator, utils/*
  src/orchestrator/final-review.ts    → types/tui, utils/process
  src/orchestrator/orchestrator.ts    → all orchestrator/*, types/*, state

Level 5 (top-level, depends on everything):
  src/tui/*                → types/core, types/tui, types/validation
  src/tui/hooks/*          → types/*, orchestrator/*
  src/app.tsx              → tui/*, tui/hooks/*
  src/cli.ts               → types/core, config, app
```

## Forbidden Dependencies

These import directions MUST NOT exist:

- `types/*` MUST NOT import from `src/` (types are leaf modules)
- `types/core.ts` MUST NOT import from other `types/*.ts` files
- `types/validation.ts` MUST NOT import from other `types/*.ts` files
- `types/spec.ts` MUST NOT import from other `types/*.ts` files
- `state.ts` MUST NOT import from `orchestrator/` or `tui/`
- `config.ts` MUST NOT import from `orchestrator/` or `tui/`
- `spec/*` MUST NOT import from `tui/`
- `utils/*` MUST NOT import from `orchestrator/`, `tui/`, or `spec/`

## Extracted Orchestrator Module Contracts

### `orchestrator/cost.ts`

Exports:
- `estimateCostSavings(tokenUsage, plannerTool?, implementerProvider?): string`
- `calculateCostBreakdown(tokenUsage, totalTasks, escalatedCount, plannerTool?, implementerProvider?): CostBreakdown`

Pure functions. No side effects. No file I/O.

### `orchestrator/approval-loop.ts`

Exports:
- `runApprovalLoop(ctx: WorkflowContext, state: WorkflowState, tasks: Task[]): Promise<{ state: WorkflowState; aborted: boolean; summary?: Summary }>`

Side effects: calls `planner.regenerate()`, reads/writes spec files via `readSpecFile`/`writeSpecFile`, emits events via `callbacks.onEvent`, saves state via `saveState`.

### `orchestrator/retry-escalation.ts`

Exports:
- `handleRetryAndEscalation(ctx: WorkflowContext, task: Task, initialError: string, state: WorkflowState, taskStartTime?: number): Promise<RetryResult>`

Side effects: calls `retryTask`, `implementTask`, `validateTask`, `commitChanges`, emits events, saves state.

### `orchestrator/final-review.ts`

Exports:
- `runFinalReview(projectDir: string, callbacks: OrchestratorCallbacks): Promise<{ text: string; usage: { prompt: number; completion: number } | null }>`

Side effects: spawns `claude` subprocess, reads spec/diff from disk.

## Custom Hook Contracts (app.tsx decomposition)

### `tui/hooks/use-interaction.ts`

```
useInteraction(auto: boolean) → {
  // State
  approval, inputMode, taskPreview, taskReview,
  // Callback factories (return Promises resolved by user interaction)
  requestApproval, requestExternalChanges, askQuestion,
  requestTaskPreview, requestTaskReview
}
```

### `tui/hooks/use-workflow.ts`

```
useWorkflow(params: UseWorkflowParams) → {
  events, phase, currentTask, totalTasks, localRate,
  model, startedAt, costBreakdown, addEvent
}
```

### `tui/hooks/use-app-navigation.ts`

```
useAppNavigation(params: UseAppNavigationParams) → {
  screen, feature, mode, overlay, slashOutput, summaryData,
  startWorkflow, showSummary, setOverlay, changeMode, handleSlashCommand
}
```
