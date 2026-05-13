# 04 — Auto-Snapshot Triggers

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Wire auto-snapshot triggers into the orchestrator so that snapshots are automatically created before each task, after each successful task, and before the final review — when enabled by config. All triggers are off by default in v1.

This brief assumes briefs 01, 02, and 03 are complete: `createSnapshot` is in `src/engine/snapshots/store.ts`, `restoreSnapshot` in `src/engine/snapshots/restore.ts`, and the schema and path helpers exist.

## Read First

- `CLAUDE.md`
- `src/core/schemas/config.ts` — current `ConfigSchema` shape; the `workflow` object and its optional sub-objects (note `speckit`, `git` patterns)
- `src/engine/orchestrator/task-loop.ts` — the `runTaskLoop` function and where `runSingleTask` is called (around line 118)
- `src/engine/orchestrator/final-review.ts` — where `runFinalReviewPhase` begins and emits `all_tasks_done` (around line 33–36)
- `src/engine/orchestrator/types.ts` — `WorkflowContext` shape (to confirm `config` and `bus` are accessible)
- `src/engine/events/types.ts` — existing `Phase` type and event union
- `src/engine/orchestrator/evidence.ts` — pattern for try/catch/warn in orchestrator helpers

## Files To Touch

- `src/core/schemas/config.ts` — add `SnapshotsConfigSchema` and `snapshots` field to `ConfigSchema`
- `src/engine/orchestrator/task-loop.ts` — pre-task and post-task auto-snapshot calls
- `src/engine/orchestrator/final-review.ts` — pre-final-review auto-snapshot call
- `docs/CONFIG.md` — document the new `snapshots` config section
- `docs/WORKFLOW.md` — document auto-snapshot behavior

Do not touch CLI, schema, or test files outside orchestrator in this brief.

## Config Schema Changes

Add to `src/core/schemas/config.ts`:

```ts
export const SnapshotsAutoConfigSchema = z.object({
  preTask: z.boolean().optional(),
  postTask: z.boolean().optional(),
  preFinalReview: z.boolean().optional(),
});

export const SnapshotsConfigSchema = z.object({
  auto: SnapshotsAutoConfigSchema.optional(),
});
```

Add to `ConfigSchema`:

```ts
snapshots: SnapshotsConfigSchema.optional(),
```

Place `snapshots` after `otel` at the bottom of `ConfigSchema` to minimize diff. The field is entirely optional; existing config files without it continue to parse correctly (additive change).

### YAML Example (for docs/CONFIG.md)

```yaml
snapshots:
  auto:
    preTask: true      # snapshot before each task begins
    postTask: true     # snapshot after each task succeeds
    preFinalReview: false  # snapshot before final review (default off)
```

All three default to `false` / absent.

## Orchestrator Integration

### Helper Function

Add a private helper in `src/engine/orchestrator/task-loop.ts` (or import from a new thin module if preferred — keep the file's existing style):

```ts
async function maybeAutoSnapshot(opts: {
  projectDir: string;
  sessionId: string;
  config: WorkflowContext['config'];
  bus: EventBus;
  phase: Phase;
  enabled: boolean;
  taskIndex?: number;
  label: string;
}): Promise<void> {
  if (!opts.enabled) return;
  try {
    await createSnapshot({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      phase: opts.phase,
      name: opts.label,
      taskIndex: opts.taskIndex,
      bus: opts.bus,
    });
  } catch (err) {
    publishWarning(opts.bus, opts.phase, labelError(`auto-snapshot (${opts.label}) failed`, err));
  }
}
```

`createSnapshot` is imported from `../../engine/snapshots/store.js` (adjust relative path as needed). This import must stay within engine/ → engine/ — no React/Ink.

### Pre-Task Hook

In `runTaskLoop`, immediately before the call to `runSingleTask` (after the dependency-check `if` block), add:

```ts
await maybeAutoSnapshot({
  projectDir,
  sessionId,
  config,
  bus: wctx.bus,
  phase: state.phase,
  enabled: config.snapshots?.auto?.preTask === true,
  taskIndex: i,
  label: `pre-task-${i}`,
});
```

### Post-Task Hook

In `runTaskLoop`, immediately after the call to `runSingleTask` returns a new `state`, check if the task succeeded before snapshotting:

```ts
const completedTask = state.tasks[i];
const succeeded = completedTask?.status === 'completed';
await maybeAutoSnapshot({
  projectDir,
  sessionId,
  config,
  bus: wctx.bus,
  phase: state.phase,
  enabled: succeeded && config.snapshots?.auto?.postTask === true,
  taskIndex: i,
  label: `post-task-${i}`,
});
```

`TaskStatus` is imported from `../../core/schemas/enums.js` — confirm the string value `'completed'` against the existing enum before implementing.

### Pre-Final-Review Hook

In `src/engine/orchestrator/final-review.ts`, add after the `ALL_DONE` transition (line ~33) and before the `all_tasks_done` event publish:

```ts
await maybeAutoSnapshot({
  projectDir,
  sessionId,
  config: opts.config,  // confirm WorkflowContext carries config here
  bus,
  phase: state.phase,
  enabled: opts.config.snapshots?.auto?.preFinalReview === true,
  label: 'pre-final-review',
});
```

Read `final-review.ts` carefully: confirm `opts.config` is accessible. If it is not directly on `opts`, trace back to `WorkflowContext` passed into the function and use `wctx.config` or equivalent.

## Events

No new event variants are needed in this brief. `createSnapshot` already emits `snapshot_created` when a `bus` is provided (brief 02). The orchestrator warning path uses the existing `warning` event (already in `src/engine/events/types.ts`).

## Docs Changes

### docs/CONFIG.md

Add a new section `## snapshots` with:

- Description of the `snapshots.auto` sub-object.
- Table of the three boolean keys (`preTask`, `postTask`, `preFinalReview`), their defaults (`false`), and what each does.
- The YAML example from above.
- Note: "All auto-triggers are off by default. Failures warn and do not abort the run."

### docs/WORKFLOW.md

Add a paragraph to the appropriate section explaining:

- Users can enable automatic snapshots via the `snapshots.auto` config keys.
- Manual snapshots are always available via `diptych snapshot create`.
- Auto-snapshot failures emit a warning and do not abort the run.

## Tests

There are no new unit tests required for this brief (the orchestrator integration is tested via the existing integration test suite). However, add or extend tests if `src/engine/orchestrator/task-loop.test.ts` or `testing/integration/orchestrator/` already has a pattern for testing orchestrator helpers:

- If a task-loop integration test exists, add a case: `auto.postTask=true` causes `snapshot_created` event after a successful task.
- If no integration test pattern exists, add a minimal unit test for `maybeAutoSnapshot`: it calls `createSnapshot` when `enabled=true` and skips it when `enabled=false`.

Do not write integration tests that require a real implementer process.

## Acceptance Criteria

- `SnapshotsConfigSchema` is exported from `src/core/schemas/config.ts`.
- `ConfigSchema.snapshots` is an optional field.
- Existing config files without `snapshots` continue to parse without error.
- `runTaskLoop` calls `maybeAutoSnapshot` before and after `runSingleTask`.
- `runFinalReviewPhase` calls `maybeAutoSnapshot` before the final review.
- Auto-snapshot failures emit `warning` and do not throw.
- `docs/CONFIG.md` documents the new config section.
- `npm run test-ci` passes.

## Constraints

- Do not make `snapshots` a required field in `ConfigSchema`.
- Do not import from React / Ink / `src/features/` in `task-loop.ts` or `final-review.ts`.
- Do not change the signature of `runTaskLoop` or `runFinalReviewPhase`.
- The `maybeAutoSnapshot` helper must be private to the orchestrator module (not exported).

## Escalation

If `WorkflowContext` (in `src/engine/orchestrator/types.ts`) does not carry `config`, trace where config is accessed inside `final-review.ts` and use the same accessor.

If `state.tasks[i]?.status` is not the right selector for "task succeeded", check `src/core/state/selectors.ts` for `getCompletedTaskIds` and use that instead:

```ts
const succeeded = getCompletedTaskIds(state).includes(task.id);
```

## Verification Commands

```bash
npm test -- src/engine/orchestrator/task-loop.test.ts
npm run typecheck
npm run lint
npm test
```
