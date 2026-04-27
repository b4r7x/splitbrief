# 01 — Plan Editor Store

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Brief 01 of 5. Creates the module-scoped state store for the plan editor. No React component code in this brief — the store must be importable by the component (brief 03) and by the save handler (brief 05) without mounting anything.

## Intent

Create `src/stores/workflow/plan-editor.ts` — a `createStore`-based store that holds the editor's full runtime state: the mutable task list, cursor position, expand state, dirty flag, and the runtime opt-in flag (`runtimeRichMode`) that lets `e` from the simple view activate the editor for the current session.

## Scope

**In bounds:**
- `src/stores/workflow/plan-editor.ts` (new file)
- `src/stores/workflow/plan-editor.test.ts` (new file, colocated)

**Out of bounds:**
- No changes to any engine file.
- No changes to `screen.tsx` or any component — that is brief 03.
- No config schema changes — those belong to brief 03.
- Do not add the store to any barrel.

## Code Context

**Store pattern (read this file):** `src/stores/workflow/review.ts`

The pattern is: `createStore(initial)`, then export named action functions that call `store.set(...)`, then compose them into a named export object via `storeBase`.

```ts
// src/stores/create-store.ts exports:
export function createStore<T>(initialOrFactory: T | (() => T)): Store<T>
export const storeBase = <T>(s: Store<T>) => ({ use: s.use, get: s.get, subscribe: s.subscribe, reset: s.reset });
```

**Task type:** `src/core/schemas/task.ts`

```ts
export type Task = z.infer<typeof TaskSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
```

## Implementation Plan

### 1. Define the state shape

```ts
// src/stores/workflow/plan-editor.ts

import type { Task } from '../../core/schemas/task.js';

export interface PlanEditorState {
  /** Current mutable task list. Empty until the editor is initialized. */
  tasks: Task[];
  /** Zero-based index of the cursor within tasks[]. Clamped to [0, tasks.length - 1]. */
  cursor: number;
  /** Set of task IDs whose full body is expanded (toggled by <enter>). */
  expandedIds: ReadonlySet<string>;
  /**
   * True when the in-memory task list differs from what is on disk.
   * Set to true on any edit operation. Set to false after successful save.
   */
  dirty: boolean;
  /**
   * True when the user pressed `e` from the simple BriefReviewView to opt into
   * the rich editor for this session only. Not persisted to config.
   */
  runtimeRichMode: boolean;
  /**
   * Non-null while an error message from the last save attempt should be shown.
   * Cleared on the next edit operation or on successful save.
   */
  saveError: string | null;
}
```

### 2. Implement actions

Export these named action functions (not methods on an object):

```ts
function initEditor(tasks: Task[]): void
```
Resets the store to its initial state, then sets `tasks` to the provided list. Called by the component on mount when entering `reviewing-briefs`.

```ts
function moveCursor(direction: 'up' | 'down'): void
```
Moves cursor by ±1, clamped to `[0, tasks.length - 1]`. No-op if list is empty.

```ts
function setTasks(tasks: Task[]): void
```
Replaces the task list and sets `dirty: true`. Used by action handlers (brief 02) to commit the result of an edit operation.

```ts
function toggleExpand(taskId: string): void
```
Toggles membership of `taskId` in `expandedIds`. Creates a new `Set` — do not mutate in place.

```ts
function setRuntimeRichMode(value: boolean): void
```
Sets `runtimeRichMode`. Called by keystroke handler when `e` is pressed from simple view.

```ts
function setCursor(n: number): void
```
Sets cursor to an absolute index, clamped to `[0, tasks.length - 1]`. Used by delete and merge operations (via brief 02) to position the cursor at the correct task after the list changes length. If `tasks` is empty, cursor is set to 0.

```ts
function setSaveError(message: string | null): void
```
Sets or clears the save error message.

```ts
function markSaved(): void
```
Sets `dirty: false` and `saveError: null`. Called by brief 05 after successful save.

### 3. Export the store object

```ts
export const planEditorStore = {
  ...storeBase(store),
  initEditor,
  moveCursor,
  setCursor,
  setTasks,
  toggleExpand,
  setRuntimeRichMode,
  setSaveError,
  markSaved,
};
```

Include a `__testReset` function following the pattern in `src/stores/workflow/lifecycle.ts` — same `_planEditorInternal` export for the `set` escape hatch if needed by tests.

## Validation

### Tests to write in `plan-editor.test.ts`

All tests operate on the store directly — no React, no Ink, no component mounting.

- `initEditor` resets cursor to 0 and sets dirty to false.
- `initEditor` with a non-empty list sets `tasks` correctly.
- `moveCursor('down')` increments cursor, clamped at `tasks.length - 1`.
- `moveCursor('up')` decrements cursor, clamped at 0.
- `moveCursor` is a no-op when tasks is empty.
- `setTasks` replaces the task list and sets `dirty: true`.
- `toggleExpand` adds an ID not in the set.
- `toggleExpand` removes an ID already in the set.
- `setCursor(2)` sets cursor to 2 when task list has 3+ items.
- `setCursor(-1)` clamps to 0.
- `setCursor(999)` clamps to `tasks.length - 1`.
- `setCursor(0)` on empty list sets cursor to 0.
- `setRuntimeRichMode(true)` sets the flag; `false` clears it.
- `setSaveError` sets the error string; `null` clears it.
- `markSaved` sets `dirty: false` and `saveError: null`.
- `__testReset` returns store to initial state.

### Verify

```bash
npm test -- src/stores/workflow/plan-editor.test.ts
npm run typecheck
npm run lint
```

## Constraints

- No classes.
- No barrel exports.
- ESM `.js` suffix on all imports.
- `expandedIds` must be a `ReadonlySet<string>` in the state type; create a new `Set` on every `toggleExpand` call — no in-place mutation.
- Do not import from `ink`, `react`, or anything under `src/features/`, `src/components/`.

## Escalation

If `createStore` does not support factory functions for the initial state (needed for `expandedIds: new Set()`), use the factory-function overload: `createStore<PlanEditorState>(() => ({ ..., expandedIds: new Set() }))`. The implementation already supports this — see `src/stores/create-store.ts` line 19.

## Evidence

- `src/stores/workflow/plan-editor.ts` created.
- `src/stores/workflow/plan-editor.test.ts` created with all tests passing.
- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
