# Research: SRP Refactoring

**Date**: 2026-03-28
**Agents dispatched**: 6 parallel Opus agents
**All unknowns resolved**: Yes

## 1. Barrel Re-exports in ESM with NodeNext

**Decision**: Do NOT use barrel `index.ts` files. Keep direct file-to-file imports.

**Rationale**:
- Under `module: "NodeNext"` / `moduleResolution: "NodeNext"`, Node.js ESM does NOT auto-resolve `./types.js` to `./types/index.js`. Every consumer would need to change their import path anyway.
- With `rewriteRelativeImportExtensions: true` (TypeScript 5.7+), `.ts` in source is rewritten to `.js` in output, but path shapes are not altered.
- The project has zero barrel files today — direct imports are the established pattern.
- A barrel at `orchestrator/index.ts` would create a runtime circular dependency risk: `spec/formatter.ts` imports `extractFunctionContext` from `orchestrator/context-extractor.js` (value import), while orchestrator modules import from `spec/`.
- This is a CLI app, not a library — barrels provide no public API ergonomic benefit.

**Alternatives considered**:
- Barrel with re-exports: Rejected due to NodeNext resolution limitations and circular risk.
- TypeScript `paths` aliases (`#types`): Possible future enhancement for shorter import paths, but not needed for this refactoring.

**Impact on plan**: Instead of `types/index.ts` barrel, the `types.ts` file is split into subfiles under `src/types/` and every consumer updates its import path from `'../types.js'` to `'../types/core.js'`, `'../types/tui.js'`, etc. — importing only what it needs. This is cleaner than a barrel because each consumer explicitly declares its domain dependencies.

## 2. The `currentTasks` Variable — Scaffolding for Incomplete Feature

**Decision**: Fix, not remove. Wire up cascading task re-parse after plan regeneration.

**Rationale**:
- `currentTasks` (orchestrator.ts:399) is declared with `let` but never reassigned — always equals the original `tasks`.
- Task T026 in the 009-ux-overhaul spec mandated cascading regeneration: "when spec changes, auto-regenerate plan + tasks."
- The plan regeneration code (lines 463-475) calls `planner.regenerate()` which returns `RegenerateResult { text, usage }` — no task data. The regenerated plan file is written to disk but tasks are never re-parsed.
- `PLAN_DONE` transition on line 478 passes stale `currentTasks` into state.
- The fix: after plan regeneration, re-parse tasks from the updated `tasks.md` file on disk (using the existing `parseTasks()` from `spec/parser.ts`), then assign to `currentTasks`.

**Alternatives considered**:
- Remove as dead code: Rejected — the feature was specified and marked complete but is actually half-wired.
- Extend `RegenerateResult` to include tasks: Over-engineering — the tasks file is already on disk, just re-read it.

## 3. Orchestrator Split Pattern — WorkflowContext Record

**Decision**: Create a `WorkflowContext` interface that bundles immutable session state. Pass it as the first parameter to all extracted functions.

**Rationale**:
- `runWorkflow` has 7 immutable values shared by every sub-function: `feature`, `projectDir`, `config`, `callbacks`, `startTime`, `planner`, `projectContext`.
- `handleRetryAndEscalation` already takes 8 parameters. The approval loop would need 11+. This doesn't scale.
- A `WorkflowContext` record reduces parameter counts by 3-6 per function without hiding dependencies.
- `WorkflowState` stays separate (mutable, returned from functions) to keep mutation flow explicit.
- The pattern is already established in the codebase: `ProjectContext` is exactly this at smaller scale.
- This satisfies "zero classes, pure functions" — an interface + object literal is not a class.

**Alternatives considered**:
- Individual parameters (current pattern): Already straining at 8-10 params. Rejected for scalability.
- Module-scoped factory (`createWorkflowOps(ctx)`): Returns a method bag — effectively a class in disguise. Rejected per constitution Principle IV.

**Natural grouping**:
| Group | Contents | Mutability |
|-------|----------|-----------|
| WorkflowContext | feature, projectDir, config, callbacks, startTime, planner, projectContext | Immutable (created once) |
| WorkflowState | phase, tasks, tokens, currentTaskIndex, permissionMode, etc. | Mutable (returned from functions) |

## 4. Dynamic Import Audit — 13 Removable, 2 Refactorable

**Decision**: Remove 11 redundant dynamic `import()` calls in `src/`, refactor 2 inline type imports to top-level static imports. Keep all factory/optional-dep/test dynamic imports.

**Findings**:

| Verdict | Count | Details |
|---------|-------|---------|
| REMOVE | 11 | Redundant dynamic imports in planner `getVersion()` methods (codex, aider, opencode, claude-code: `runCommand` already statically imported + `parseVersion` should be static) + cli.ts init (fs/path/yaml already available) |
| REFACTOR | 2 | `types.ts:231` inline `import('./orchestrator/question-parser.js').ClarificationQuestion` → top-level import type; `orchestrator.ts:394` inline `import('../types.js').PermissionMode` → add to existing top-level import |
| KEEP | 55 | Factory pattern in `planners/factory.ts` (6 lazy planner loads), optional dependency probes in `agent-sdk.ts` (2), all test-file dynamic imports for module re-loading (~45), 2 typeof expressions in planner-detection tests |

**Key offenders**:
- `codex.ts:349-350`, `aider.ts:313-314`, `opencode.ts:334-335`, `claude-code.ts:394,397` — each dynamically imports `runCommand` (already statically imported in 3/4 files) and `parseVersion` (never statically imported but should be)
- `cli.ts:102-104` — dynamically imports `node:fs`, `node:path`, `yaml` inside the `init` function despite all being available statically

## 5. App.tsx Hook Extraction — 19 useState Hooks, 4 Clusters, 3 Custom Hooks

**Decision**: Extract into 3 custom hooks: `useInteraction`, `useWorkflow`, `useAppNavigation`.

**Findings**: The component actually has **19 useState hooks** (not 15 as initially counted), organized into 4 logical clusters:

| Cluster | States | Purpose |
|---------|--------|---------|
| A: Workflow | events, phase, currentTask, totalTasks, localCount, escalatedCount, model, startedAt, workflowStarted, summaryData | Orchestrator progress tracking |
| B: Screen | screen, feature, slashOutput | Navigation and display |
| C: Interaction | approval, inputMode, taskPreview, taskReview | Promise-based user prompts |
| D: Mode/Overlay | mode, overlay | Permission mode and UI overlays |

**Proposed hooks**:

1. **`useInteraction(auto: boolean)`** — Owns Cluster C. Returns interaction state + callback factories for promise-based modals. Eliminates nested Promise/setState dance from component body.

2. **`useWorkflow(params)`** — Owns Cluster A + `modeRef`. Receives interaction callbacks. Returns workflow progress data. The `modeRef` stale-closure workaround becomes an internal implementation detail.

3. **`useAppNavigation(params)`** — Owns Clusters B + D. Returns screen/feature/mode/overlay state + slash command handler. The 90-line `onSlashCommand` handler (lines 253-343) moves entirely into this hook.

**After extraction**: App becomes ~80-100 lines — hook instantiation + JSX render tree. No `useEffect`, no `useRef`, no complex state.

**Bonus fix**: The current `modeRef` pattern has a subtle bug: `onTaskApproval`/`onTaskReview` are set to `undefined` at workflow-start if mode is not `'supervised'`, and switching to supervised mid-workflow doesn't retroactively add them. A hook-based design can always provide the callbacks but gate behavior on the live ref value inside the callback body.

## 6. Type Dependency Graph — Acyclic with One Adjustment

**Decision**: Move `Phase` from `tui.ts` to `core.ts`. This eliminates the `state.ts → tui.ts` dependency edge.

**Original proposal** (from quality audit):

```
core.ts        → (nothing)
validation.ts  → (nothing)
spec.ts        → (nothing)
tui.ts         → core.ts, validation.ts
state.ts       → core.ts, tui.ts, validation.ts  ← problem: state depends on TUI
```

`Phase` is a workflow/state machine concept (the stage of orchestration), not a TUI concept. Placing it in `tui.ts` forces `state.ts` to depend on the UI layer — semantically backwards.

**Revised assignment** (Phase moved to core.ts):

```
Level 0 (leaves): core.ts, validation.ts, spec.ts
Level 1 (composites): tui.ts, state.ts (independent siblings)
```

```
core.ts        → (nothing)         [LEAF]
validation.ts  → (nothing)         [LEAF]
spec.ts        → (nothing)         [LEAF]
tui.ts         → core.ts, validation.ts
state.ts       → core.ts, validation.ts
```

**No cycles. Clean two-level DAG.**

**Final type assignment**:

| File | Types |
|------|-------|
| `core.ts` | Phase, PermissionMode, TaskStatus, PlannerTool, OutputFormat, Task, Config, ProjectContext |
| `validation.ts` | ValidationResult, TokenUsage, TaskTokenUsage, CostBreakdown, Summary |
| `spec.ts` | TokenBudget, CodeContext |
| `tui.ts` | TldrChangeset, TuiEvent, OrchestratorCallbacks |
| `state.ts` | WorkflowState, StateAction, Event |
