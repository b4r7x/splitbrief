# 03 — Orchestrator Integration

> Fresh AI context brief. Implement only this change. Never stage or commit.
> **Depends on:** brief 01 (`drift-chain-state.ts`) and brief 02 (`drift-chain.ts`, `computePerTaskOutOfBounds`, `analyzeDriftChain`).

## Goal

Wire chain analysis into the task execution loop so that after every non-skipped task, the chain state is updated and persisted. Chain detection must be fault-tolerant: any failure is swallowed and published as a `warning` event; the task loop must never abort because of chain analysis.

## Read First

- `CLAUDE.md`
- `src/engine/orchestrator/task-step.ts` — this is the primary integration file
- `src/engine/orchestrator/task-loop.ts` — understand where skipped tasks are handled (do not touch)
- `src/engine/orchestrator/drift.ts` — read to understand patterns; do not modify
- `src/engine/orchestrator/drift-chain-state.ts` — from brief 01
- `src/engine/orchestrator/drift-chain.ts` — from brief 02
- `src/core/schemas/task.ts` — `Task.scope.approvedOutOfBounds` (added in brief 02)
- `src/engine/orchestrator/events.ts` — understand `publishWarning`
- `src/lib/git.ts` — understand how git utilities are used in the orchestrator

## Files To Modify

- `src/engine/orchestrator/task-step.ts` — add chain analysis call after each task terminal point

Do not create new files in this brief. Do not modify `task-loop.ts`, `drift.ts`, or `drift.test.ts`.

## Per-Task Changed Files

Chain analysis needs the files changed during a specific task, not the entire session diff. Before adding new git helpers, check whether `src/lib/git.ts` already exports an equivalent function (such as one that returns changed files since a given ref). If it does, use it. If not, add the helpers below as private functions in `task-step.ts` — do not add them to `src/lib/git.ts` to avoid cross-concern pollution.

Collect per-task changed files using `git diff --name-only` between a baseline and the current HEAD:

```ts
import { execSync } from 'node:child_process';

function getChangedFilesSince(projectDir: string, baseRef: string): string[] {
  try {
    const out = execSync(`git diff --name-only ${baseRef}`, {
      cwd: projectDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out.length === 0 ? [] : out.split('\n').map(f => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
```

Before each task begins (after `START_TASK` transition), capture the current HEAD commit SHA:

```ts
function getCurrentCommitSha(projectDir: string): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'HEAD';
  }
}
```

Store this SHA as `taskStartRef` and pass it through to the chain analysis call after the task completes.

If `git rev-parse HEAD` fails (e.g., repository with no commits), use `'HEAD'` as the fallback. The `getChangedFilesSince('HEAD')` call will likely return nothing in that case, which is safe.

## Integration Points In `task-step.ts`

There are three terminal points for a non-skipped task in `runSingleTask`:

### 1. Local success path (line ~238)

After `persistTaskEvidence(..., 'local', ...)` and before `return state`:

```ts
await runChainAnalysisSafe({
  wctx, task, projectDir, sessionId, state, taskStartRef, bus: wctx.bus,
});
return state;
```

### 2. Retry/escalation path (lines ~192–196 and ~247–251)

After `retryAndRecord` returns, before `return retry.state`:

```ts
await runChainAnalysisSafe({
  wctx, task, projectDir, sessionId, state: retry.state, taskStartRef, bus: wctx.bus,
});
return retry.state;
```

There are two `retryAndRecord` call sites in `runSingleTask` (one after implementation error, one after validation failure). Both need the chain analysis call.

### `runChainAnalysisSafe`

Add a private helper (not exported) in `task-step.ts`:

```ts
async function runChainAnalysisSafe(opts: {
  wctx: WorkflowContext;
  task: Task;
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  taskStartRef: string;
  bus: EventBus;
}): Promise<void> {
  try {
    const taskChangedFiles = getChangedFilesSince(opts.projectDir, opts.taskStartRef);
    const outOfBoundsFiles = computePerTaskOutOfBounds(opts.task, taskChangedFiles);

    const existing = readDriftChainState(opts.projectDir, opts.sessionId)
      ?? initialDriftChainState(opts.sessionId);

    const threshold = opts.wctx.config.workflow.driftChainThreshold ?? 0.6;
    const update = analyzeDriftChain(existing, opts.task.id, outOfBoundsFiles, threshold);

    writeDriftChainState(opts.projectDir, opts.sessionId, update.state);

    if (update.emitted) {
      publishDriftChainDetected(opts.bus, opts.state.phase, update.emitted, threshold);
    }
  } catch (err) {
    publishWarning(opts.wctx.bus, opts.state.phase, `drift chain analysis failed: ${toErrorMessage(err)}`);
  }
}
```

`publishDriftChainDetected` is defined in brief 04. In this brief, you may stub it as a no-op or leave a TODO comment — brief 04 will implement it. The chain state write still happens.

If you prefer to avoid the dependency on brief 04 for the initial implementation: inline the event publish using `bus.publish({ type: 'drift_chain_detected', ... })` after brief 04 adds the event variant to `EngineEvent`. Brief 04 will also refactor this call site if needed, since it owns the event shape.

## `taskStartRef` Threading

The `taskStartRef` must be captured before the task runs. In `runSingleTask`, capture it after the `START_TASK` transition:

```ts
state = transitionAndSave(projectDir, sessionId, state, { type: 'START_TASK', taskId: opts.task.id });
setTrackedState(state);

const taskStartRef = getCurrentCommitSha(projectDir);
```

Pass `taskStartRef` to all three `runChainAnalysisSafe` call sites within `runSingleTask`.

## Chain State Reset On Rewind

When a `rewind_to_spec` or `rewind_to_plan` event is published, the chain state should be reset. The cleanest place to do this is in `task-step.ts` by checking the transition type — but rewinding happens in planning, not in task execution, so this reset belongs in the planning path.

Add a helper export to `drift-chain-state.ts` (this is a minor addition; brief 01 may not have included it):

```ts
export function resetDriftChainState(projectDir: string, sessionId: string): void {
  const empty = initialDriftChainState(sessionId);
  writeDriftChainState(projectDir, sessionId, empty);
}
```

Call `resetDriftChainState` in `src/engine/orchestrator/planning/shared.ts` (or wherever rewind transitions are applied) when `type === 'REWIND_TO_SPEC'` or `type === 'REWIND_TO_PLAN'`. Wrap in try/catch to avoid affecting planning if the reset fails.

## Config Field

The `driftChainThreshold` field must be added to the workflow config schema so TypeScript accepts `config.workflow.driftChainThreshold`. Find `src/core/schemas/config.ts` (or wherever `WorkflowConfig` is defined) and add:

```ts
driftChainThreshold: z.number().min(0).max(1).optional(),
```

Do not add a default in the schema — the default `0.6` is applied in `runChainAnalysisSafe` with `?? 0.6`. This avoids a schema migration for existing config files.

## Imports To Add To `task-step.ts`

```ts
import { execSync } from 'node:child_process';
import { computePerTaskOutOfBounds, analyzeDriftChain } from './drift-chain.js';
import { readDriftChainState, writeDriftChainState, initialDriftChainState } from './drift-chain-state.js';
// publishDriftChainDetected imported from brief 04's events module, or stubbed
```

## Tests

Add tests to a new file `src/engine/orchestrator/drift-chain-integration.test.ts` (NOT modifying the existing `drift.test.ts`).

Cover:

- After a task completes locally with out-of-bounds files, `drift-chains.json` is written.
- After a task completes cleanly (no out-of-bounds files), the active chain is reset in `drift-chains.json`.
- `runChainAnalysisSafe` does not throw when git is unavailable (mock `execSync` to throw).
- A warning event is published when chain analysis fails internally.

Use a temporary directory for `projectDir`. Mock `execSync` to return controlled file lists. Do not call real git.

Example mock pattern:

```ts
import { vi } from 'vitest';
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('src/extra.ts\n'),
}));
```

## Acceptance Criteria

- `runChainAnalysisSafe` is called after every non-skipped task terminal point.
- `drift-chains.json` is written after each analyzed task.
- Chain analysis failure produces a `warning` event and does not abort the task loop.
- `driftChainThreshold` is an optional field on the workflow config schema.
- Chain state resets on rewind transitions.
- Existing `drift.ts` and `drift.test.ts` are unchanged.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/drift-chain-integration.test.ts
npm run typecheck
npm run lint
npm test
```
