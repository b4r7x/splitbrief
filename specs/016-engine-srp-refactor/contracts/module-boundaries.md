# Module Boundary Contracts

**Date**: 2026-04-01 | **Branch**: `016-engine-srp-refactor`

This document defines the public API contracts for extracted modules. These are the interfaces that consumers depend on — internal implementations may change freely.

## 1. Planner Base Contract

**File**: `src/engine/planners/base.ts`

### Exports

| Export | Type | Consumers |
|--------|------|-----------|
| `buildProjectContext(projectDir, options?)` | Function → `string` | All 6 planner backends |
| `listDir(dirPath)` | Function → `string` | `buildProjectContext` only (internal) |
| `createPlannerBase(config)` | Function → `PlannerBackend` | All 6 planner backends |
| `InvokeResult` | Interface | Planner backends |
| `InvokeFn` | Type alias | Planner backends |
| `PlannerBaseConfig` | Interface | Planner backends |

### Contract Rules

- `createPlannerBase` MUST return a complete `PlannerBackend` (satisfying the existing interface in `types.ts`)
- `buildProjectContext` MUST produce identical output to the current per-planner copies
- The returned `PlannerBackend.plan()` MUST call `invokePlan` exactly 4 times in order: research, specify, plan, generate-tasks
- The returned `PlannerBackend.plan()` MUST write 4 files: `research.md`, `spec.md`, `plan.md`, `tasks.md`

---

## 2. Orchestrator Module Contracts

**Directory**: `src/engine/orchestrator/`

### Public API (via index.ts re-exports)

The public API MUST remain identical to the current `orchestrator.ts`:

| Export | Consumers |
|--------|-----------|
| `runWorkflow(feature, projectDir, config, callbacks, savedState?, selectedSkills?)` | `hooks/use-workflow.ts` |
| `estimateCostSavings(state)` | `ui/cost-footer.tsx` |
| `calculateCostBreakdown(state, config)` | `ui/summary.tsx` |
| `allValidationsPassed(results)` | `orchestrator/task-runner.ts` |
| `hasDependencyFailed(task, state)` | `orchestrator/task-runner.ts` |

### Internal Contracts (module-to-module)

| From | To | Function |
|------|----|----------|
| `index.ts` | `cost.ts` | `estimateCostSavings`, `calculateCostBreakdown`, `buildSummary` |
| `index.ts` | `tokens.ts` | `addPlannerUsage`, `addImplementerUsage`, `tokenDelta` |
| `index.ts` | `helpers.ts` | `buildContext`, `emit`, `persistClarifications`, `emitValidationResult` |
| `index.ts` | `final-review.ts` | `runFinalReview` |
| `index.ts` | `task-runner.ts` | `validateCommitAndAdvance`, `handleRetryAndEscalation` |
| `task-runner.ts` | `tokens.ts` | `addImplementerUsage`, `addEscalationUsage`, `tokenDelta` |
| `task-runner.ts` | `helpers.ts` | `emit`, `emitValidationResult`, `allValidationsPassed` |

---

## 3. Implementer Module Contracts

### `src/engine/apply.ts`

| Export | Type | Consumers |
|--------|------|-----------|
| `applyCode(code, task, projectDir)` | Function | `implementer.ts`, `implementers/shell.ts`, tests |

### `src/engine/openai-stream.ts`

| Export | Type | Consumers |
|--------|------|-----------|
| `streamCompletion(client, model, messages, temperature, onProgress, config, maxTokens?)` | Function | `implementer.ts` |
| `CompletionResult` | Interface | `implementer.ts` |

### Contract Rules

- `applyCode` MUST NOT import from `implementer.ts` (no upward dependency)
- `implementers/shell.ts` MUST import `applyCode` from `../apply.js` (not `../implementer.js`)
- `implementTask` and `retryTask` public signatures MUST remain identical

---

## 4. Unchanged Contracts

These interfaces are NOT modified by this refactoring:

- `PlannerBackend` interface (`planners/types.ts`) — all methods, parameters, return types stay the same
- `WorkflowState`, `Task`, `Config`, `TuiEvent` types (`types.ts`) — no changes
- `OrchestratorCallbacks` interface (`types.ts`) — no changes
- CLI commands (`cli.ts`) — no changes
- State machine transitions (`state.ts`) — no changes
