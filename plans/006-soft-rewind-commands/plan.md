# 006 — Soft Rewind Slash Commands — Plan

## Data model

### State-machine actions

**File:** `src/core/state/machine.ts`

Add three actions:

```ts
| { type: 'REWIND_TO_SPEC' }
| { type: 'REWIND_TO_PLAN' }
| { type: 'RESET_TASK'; taskId: TaskId }
```

Reducers:

```ts
case 'REWIND_TO_SPEC':
  return { ...state, phase: 'specifying', tasks: [], currentTaskIndex: 0, attempt: 0, awaitingContinue: false };
case 'REWIND_TO_PLAN':
  return { ...state, phase: 'planning', tasks: [], currentTaskIndex: 0, attempt: 0, awaitingContinue: false };
case 'RESET_TASK': {
  const idx = state.tasks.findIndex(t => t.id === action.taskId);
  if (idx < 0) return state;
  return {
    ...state,
    tasks: state.tasks.map((t, i) => i === idx ? { ...t, status: 'pending' } : t),
    currentTaskIndex: idx,
    attempt: 0,
    phase: 'implementing',
  };
}
```

### Slash command registry

**File:** `src/core/commands/definitions.ts`

Register entries with:
- `id: 'revise-spec' | 'revise-plan' | 'redo-task'`
- `trigger: '/revise-spec' | '/revise-plan' | '/redo-task'`
- `phaseGuard(phase): boolean` — returns true if the command is valid in this phase
- `handler(args, ctx): Promise<void>` — logic

### Event types

**File:** `src/core/types/events.ts`

Add `rewind_to_spec`, `rewind_to_plan`, `task_reset` to the `OrchestratorEventType` union with appropriate payload shapes.

## Handler implementations

### `/revise-spec`

**File:** `src/core/commands/handlers/revise-spec.ts` (new)

```ts
export async function handleReviseSpec(args: string, ctx: CommandContext): Promise<void> {
  const { projectDir, sessionId, planner, state, callbacks } = ctx;
  const comment = args.trim();

  emit(projectDir, sessionId, state, 'rewind_to_spec', { comment });
  state = transitionAndSave(projectDir, sessionId, state, { type: 'REWIND_TO_SPEC' });

  if (!comment) {
    // No regeneration — just rewind and wait at reviewing-spec gate.
    // The normal planning flow at the next runWorkflow tick handles this.
    return;
  }

  const currentSpec = readSpecFileOrEmpty(projectDir, sessionId, SPEC_FILE);
  const regenPrompt = buildRegeneratePrompt('spec', currentSpec, comment);
  const result = await planner.regenerate(regenPrompt, 'spec', projectDir, { onOutput: /* wire */ });
  state = addUsageAndSave(projectDir, sessionId, state, 'planner', result.usage, callbacks);
  // transition back into reviewing-spec implicitly via normal planning continuation
}
```

### `/revise-plan`

Symmetric to `/revise-spec` but for plan. Does not touch `spec.md`; does reset tasks.

### `/redo-task`

**File:** `src/core/commands/handlers/redo-task.ts` (new)

```ts
export async function handleRedoTask(args: string, ctx: CommandContext): Promise<void> {
  const { projectDir, sessionId, state } = ctx;
  const taskIdStr = args.trim();
  const taskId = parseTaskId(taskIdStr);
  if (!taskId) {
    ctx.feedback.setError(`Invalid task id: ${taskIdStr}`);
    return;
  }
  const taskExists = state.tasks.some(t => t.id === taskId);
  if (!taskExists) {
    ctx.feedback.setError(`Task ${taskIdStr} not found`);
    return;
  }
  emit(projectDir, sessionId, state, 'task_reset', { taskId });
  state = transitionAndSave(projectDir, sessionId, state, { type: 'RESET_TASK', taskId });
  // Task loop naturally picks the reset task up on the next iteration.
}
```

## Phase guards

**File:** `src/core/commands/phase-guards.ts` (new)

```ts
export function canReviseSpec(phase: Phase): boolean {
  const earliest: Phase = 'reviewing-spec';
  const terminal = phase === 'complete' || phase === 'idle';
  return !terminal && phaseOrder(phase) >= phaseOrder(earliest);
}

export function canRevisePlan(phase: Phase): boolean {
  const earliest: Phase = 'reviewing-plan';
  return phase !== 'complete' && phase !== 'idle' && phaseOrder(phase) >= phaseOrder(earliest);
}

export function canRedoTask(phase: Phase): boolean {
  return phase === 'implementing' || phase === 'validating-task' || phase === 'escalating';
}
```

`phaseOrder(phase)` helper returns an integer ordering among phases.

## Slash suggestions filter

**File:** `src/components/input-bar/use-slash-autocomplete.ts`

Extend the suggestion list to consult `phaseGuard(currentPhase)` and filter out commands whose guard returns false.

## Dependencies

**Depends on:** 002 (session paths), 003 (session.jsonl events), 005 (awaitingContinue reset on rewind).

**Consumed by:** nothing downstream — this is a UX addition.

## Risk

- **Git commits from previously-successful tasks.** If task 3 was committed and the user runs `/redo-task 3`, the old commit remains and a new one may be created. User ends up with both. Document in the command help text that redo does not revert commits.
- **User revising spec after task 10 completes.** All subsequent tasks get dropped. Completed tasks' commits remain. The run effectively starts over from planning with 10 orphan commits. That is user choice; no guardrail beyond a confirmation prompt for big rewinds (added as optional follow-up).
- **Command parsing edge cases.** `/redo-task` with no arg, `/redo-task abc`, `/redo-task 99999` — handled by the handler with user-visible error messages.

## Success verification

- `npm test` passes including new handler tests.
- Manual: in `implementing`, type `/revise-spec use refresh tokens`. Verify: tasks cleared, phase `specifying`, planner regenerates, user lands at `reviewing-spec`.
- Manual: `/redo-task 3` in `implementing` at task index 5 — task 3 status `pending`, next loop runs task 3 again.
- Manual: `/revise-spec` in `researching` → error `/revise-spec is only available after the spec is written.`
