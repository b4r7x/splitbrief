# 03 - Per-Task Reject + Regenerate

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Allow users to flag individual tasks in the plan editor and press `R` to send only those tasks back to the planner for targeted regeneration. This avoids rejecting the entire plan when only specific tasks need rework.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, rendered output, or public state.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- kebab-case file names.

## Required Reading

- `CLAUDE.md`
- `docs/STORES.md`
- `src/stores/workflow/plan-editor.ts`
- `src/features/workflow/hooks/use-plan-editor-keys.ts`
- `src/features/workflow/components/plan-editor.tsx`
- `src/engine/orchestrator/planning/shared.ts`
- `src/engine/orchestrator/planning/regen.ts`

## Write Ownership

Primary files:

```text
src/stores/workflow/plan-editor.ts (modify — add flaggedIds)
src/features/workflow/hooks/use-plan-editor-keys.ts (modify — add x and R actions)
src/features/workflow/components/plan-editor.tsx (modify — render flag markers)
src/engine/orchestrator/planning/regen-targeted.ts (new)
src/engine/orchestrator/planning/regen-targeted.test.ts (new)
src/stores/workflow/plan-editor.test.ts (modify — add flag tests)
```

Do not edit streaming files. Do not edit heartbeat files. Do not edit footer rendering (that is brief 04).

## Design

### Store Changes

In `src/stores/workflow/plan-editor.ts`, add `flaggedIds` to `PlanEditorState`:

```typescript
export interface PlanEditorState {
  // ... existing fields ...
  /** Set of task IDs flagged for rejection/regeneration. */
  flaggedIds: ReadonlySet<string>;
}
```

Add to initial state:

```typescript
flaggedIds: new Set<string>(),
```

Add store methods:

```typescript
function toggleFlag(taskId: string): void {
  store.set(s => {
    const next = new Set(s.flaggedIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    return { ...s, flaggedIds: next };
  });
}

function clearFlags(): void {
  store.set(s => {
    if (s.flaggedIds.size === 0) return s;
    return { ...s, flaggedIds: new Set<string>() };
  });
}

function getFlaggedTasks(): Task[] {
  const { tasks, flaggedIds } = store.get();
  return tasks.filter(t => flaggedIds.has(t.id));
}
```

Export these on the `planEditorStore` object.

Update `initEditor` and `__testReset` to handle `flaggedIds`.

### Keyboard Actions

In `src/features/workflow/hooks/use-plan-editor-keys.ts`, extend `PlanEditorAction`:

```typescript
export type PlanEditorAction =
  // ... existing ...
  | { type: 'toggle-flag' }
  | { type: 'regenerate-flagged' };
```

In `handlePlanEditorInput`:

```typescript
if (input === 'x') return { type: 'toggle-flag' };
if (input === 'R') return { type: 'regenerate-flagged' };
```

In `applyPlanEditorAction`:

```typescript
case 'toggle-flag': {
  const { tasks, cursor } = planEditorStore.get();
  const task = tasks[cursor];
  if (task) planEditorStore.toggleFlag(task.id);
  return;
}
case 'regenerate-flagged': {
  // Delegate to an async handler passed via the hook
  // The regeneration is async and needs planner access — signal via callback
  return;
}
```

The `regenerate-flagged` action needs an async callback. Extend `usePlanEditorKeys` to accept an `onRegenerateFlagged` callback:

```typescript
export function usePlanEditorKeys(
  isActive: boolean,
  onSave: () => Promise<void>,
  sessionDir: string,
  onTogglePacketPreview?: (() => void) | undefined,
  onRegenerateFlagged?: (() => Promise<void>) | undefined,
): void {
  // ... existing ...
  // In the useInput handler:
  if (action.type === 'regenerate-flagged') {
    if (onRegenerateFlagged) void onRegenerateFlagged();
    return;
  }
}
```

### Targeted Regeneration

Create `src/engine/orchestrator/planning/regen-targeted.ts`:

```typescript
import type { Task } from '../../../core/schemas/task.js';

export function buildTargetedRejectionComment(flaggedTasks: Task[]): string {
  if (flaggedTasks.length === 0) return '';

  const taskLines = flaggedTasks.map(t => `- ${t.id}: "${t.title}" (${t.file})`).join('\n');

  return [
    'The user has flagged the following tasks for regeneration:',
    '',
    taskLines,
    '',
    'Please regenerate ONLY these tasks. Keep all other tasks unchanged.',
    'Produce improved versions that address the same goals but with better implementation approach.',
  ].join('\n');
}
```

This function builds the comment string that is passed to the existing `regenerateTasks` function in `src/engine/orchestrator/planning/regen.ts`. The plan editor already has a path where a comment triggers regeneration (see `runBriefsApprovalLoop` in `shared.ts`). The targeted regeneration reuses this path.

### Visual Rendering

In `src/features/workflow/components/plan-editor.tsx`, modify `TaskEditorRow` to show a flag marker:

```tsx
function TaskEditorRow({ task, isCursor, isExpanded, issues, isFlagged }: {
  task: Task;
  isCursor: boolean;
  isExpanded: boolean;
  issues: BriefQualityIssue[];
  isFlagged: boolean;
}) {
  const t = useTheme();
  // ... existing logic ...
  const flagMarker = isFlagged ? '✗ ' : '';
  const prefix = isCursor ? '> ' : '  ';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={isCursor ? t.accent : t.text}>{prefix}</Text>
        {isFlagged && <Text color={t.error}>✗ </Text>}
        <Text color={statusColor}>{statusSymbol} </Text>
        <Text bold color={t.accent}>{task.id}</Text>
        {/* ... rest unchanged ... */}
      </Box>
      {/* ... rest unchanged ... */}
    </Box>
  );
}
```

In the parent `PlanEditorComponent`, pass `isFlagged` to each row:

```tsx
const flaggedIds = planEditorStore.use(s => s.flaggedIds);

// In the map:
<TaskEditorRow
  key={task.id}
  task={task}
  isCursor={absoluteIndex === cursor}
  isExpanded={expandedIds.has(task.id)}
  issues={issuesForTask}
  isFlagged={flaggedIds.has(task.id)}
/>
```

## Required Behavior

1. Press `x` on the cursor task to toggle its flagged state.
2. Flagged tasks display a red `✗` marker before the status symbol.
3. Press `R` (uppercase) to trigger regeneration of all flagged tasks.
4. Regeneration builds a comment describing the flagged tasks and sends it through the existing regeneration path.
5. After regeneration completes, flags are cleared automatically.
6. If no tasks are flagged when `R` is pressed, nothing happens (no-op).
7. Flagging is UI-only state (like expand) — it does NOT mark the editor as dirty because flags are not persisted to disk.

## Non-Goals

- No per-task rejection reason input (the comment is auto-generated).
- No inline task editing in this brief.
- No changes to the approval loop orchestrator contract.
- No footer changes (that is brief 04).
- No streaming or heartbeat changes.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Store changes must follow existing patterns (structuredClone for tasks, Set for IDs).
- The regeneration callback is wired at the component level where planner access is available.
- Tests for the store should verify: toggleFlag adds/removes IDs, clearFlags empties set, toggleFlag does NOT set dirty (flags are UI state like expandedIds).
- Tests for `buildTargetedRejectionComment` should verify output format with 1 and multiple tasks.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/stores/workflow/plan-editor.test.ts
npm test -- src/engine/orchestrator/planning/regen-targeted.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files changed
- store fields added
- keybinding mapping (x → toggle-flag, R → regenerate-flagged)
- visual rendering approach
- regeneration integration path
- validation commands run and results
- risks or follow-ups
