# 02 — Plan Editor Actions

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Brief 02 of 5. Creates pure action handlers for the plan editor. These functions take a `Task[]` and a cursor index, apply a single edit operation, and return a new `Task[]`. They have no side effects and no imports from React, Ink, or any store. They are tested directly with fixture data.

## Intent

Create `src/features/workflow/components/plan-editor/actions.ts` — pure transformation functions for delete, merge, split-parse, and reorder. These functions are the single source of truth for how edit operations affect the task list. They are called by the keystroke handler (brief 04) and the save flow (brief 05) via `planEditorStore.setTasks(...)`.

## Scope

**In bounds:**
- `src/features/workflow/components/plan-editor/actions.ts` (new file)
- `src/features/workflow/components/plan-editor/actions.test.ts` (new file, colocated)

**Out of bounds:**
- No React or Ink imports.
- No store imports — pure I/O only.
- No filesystem access — `s` (split) produces a `Task[]` by parsing a string; the caller handles reading the file.
- Do not touch `screen.tsx`, `brief-review-view.tsx`, or any store.

## Code Context

**Task schema:** `src/core/schemas/task.ts`

```ts
export type Task = {
  id: TaskId;           // branded string, e.g. "T001"
  title: string;
  action: 'create' | 'modify';
  file: string;
  dependsOn: TaskId[];
  description: string;
  signature?: string;
  currentCode?: string;
  tests: string[];
  constraints: string[];
  pattern?: string;
  typeDefs: string;
  implementationSteps: string[];
  scope?: { inBounds?: string[]; outOfBounds?: string[] };
  escalation?: string[];
  evidence?: string[];
  status: TaskStatus;
};
export const taskId = (s: string): TaskId => TaskIdSchema.parse(s);
```

**Parser:** `src/engine/spec/parser.ts` exports `parseTasks(markdown: string): Task[]`. Use this in the split-parse helper.

**Topo-sort:** `src/core/state/topo-sort.ts` exports `topoSort(tasks: Task[]): Task[]`. Call this after any operation that changes `dependsOn` to maintain topological order.

## Implementation Plan

### 1. Renumber helper

```ts
export function renumberTasks(tasks: Task[]): Task[] 
```

Assigns sequential IDs `T001`, `T002`, ... `T{n}` to `tasks` in array order. Updates every `dependsOn` reference by mapping old ID → new ID. Returns a new array (do not mutate inputs).

Algorithm:
1. Build a map `oldId → newId` by iterating the array with index `i`: `newId = taskId(`T${String(i + 1).padStart(3, '0')}`)`.
2. Map each task: `{ ...task, id: newId, dependsOn: task.dependsOn.map(dep => idMap.get(dep) ?? dep) }`.

### 2. Transitive dependency relink (used after delete)

```ts
export function relinkAfterDelete(tasks: Task[], deletedId: TaskId, deletedDependsOn: TaskId[]): Task[]
```

Replaces every occurrence of `deletedId` in any `task.dependsOn` with `deletedDependsOn` (minus any reference back to `deletedId`). Returns a new array. Does not renumber — caller calls `renumberTasks` next.

### 3. Delete

```ts
export function deleteTask(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number }
```

- If `tasks` is empty or `cursor` is out of range, return unchanged `{ tasks, cursor }`.
- Capture `deletedTask = tasks[cursor]`.
- Remove `deletedTask` from the array.
- Call `relinkAfterDelete(remaining, deletedTask.id, deletedTask.dependsOn)`.
- Call `renumberTasks(relinked)`.
- Clamp cursor: `Math.min(cursor, result.length - 1)`, minimum 0.
- Return `{ tasks: result, cursor: clampedCursor }`.

### 4. Merge

```ts
export function mergeWithPrevious(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number; error?: string }
```

- If `cursor === 0`, return `{ tasks, cursor, error: 'cannot merge first task' }`.
- `prev = tasks[cursor - 1]`, `curr = tasks[cursor]`.
- Build merged task:
  - `id`: `prev.id`
  - `title`: `${prev.title} + ${curr.title}`
  - `file`: `prev.file`
  - `action`: `prev.action === 'modify' || curr.action === 'modify' ? 'modify' : 'create'`
  - `description`: `${prev.description}\n\n---\n\n${curr.description}`
  - `tests`: `[...prev.tests, ...curr.tests]`
  - `implementationSteps`: `[...prev.implementationSteps, ...curr.implementationSteps]`
  - `constraints`: `[...prev.constraints, ...curr.constraints]`
  - `dependsOn`: set-union of `prev.dependsOn` and `curr.dependsOn`, excluding `curr.id`
  - `typeDefs`: `prev.typeDefs ? (curr.typeDefs ? `${prev.typeDefs}\n\n${curr.typeDefs}` : prev.typeDefs) : curr.typeDefs`
  - `signature`: `prev.signature ?? curr.signature`
  - `currentCode`: `prev.currentCode ?? curr.currentCode`
  - `pattern`: `prev.pattern ?? curr.pattern`
  - `scope`: merge arrays from both (concat, or `undefined` if both absent)
  - `escalation`: concat both arrays (or `undefined` if both absent)
  - `evidence`: concat both arrays (or `undefined` if both absent)
  - `status`: `'pending'`
- Replace `tasks[cursor - 1]` with merged; remove `tasks[cursor]`.
- Call `relinkAfterDelete(updated, curr.id, [])` (curr disappears, its deps already folded in).
- Call `renumberTasks`.
- New cursor = `cursor - 1`.
- Return `{ tasks: result, cursor: newCursor }`.

### 5. Reorder

```ts
export function moveTaskDown(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number }
export function moveTaskUp(tasks: Task[], cursor: number): { tasks: Task[]; cursor: number }
```

Swap adjacent elements. No renumber — IDs do not change on reorder (only on delete/merge/save). Clamp cursor. If already at boundary, return unchanged.

### 6. Parse split result

```ts
export function parseSplitResult(markdown: string, originalTask: Task): Task[] | { error: string }
```

Calls `parseTasks(markdown)`. If result has zero tasks, returns `{ error: 'split produced no tasks' }`. Otherwise returns the parsed tasks with `status: 'pending'` on each task. Does not renumber — caller does that.

The split format is identical to `tasks.md`: to split one task into two, the user adds a standard `---` separator followed by a complete YAML frontmatter block (`id:`, `title:`, `action:`, `file:`) for the second task. `parseTasks` handles multi-task markdown natively — no special marker processing is needed. The temp file written by `external-editor.ts` includes a comment at the top explaining this format.

## Validation

### Tests to write in `actions.test.ts`

Use a fixture factory — keep it in the test file. No external fixture files.

```ts
function makeTask(id: string, overrides?: Partial<Task>): Task {
  return {
    id: taskId(id),
    title: `Task ${id}`,
    action: 'create',
    file: `src/${id}.ts`,
    dependsOn: [],
    description: `Description for ${id}`,
    tests: ['it works'],
    constraints: [],
    typeDefs: '',
    implementationSteps: ['step 1'],
    status: 'pending',
    ...overrides,
  };
}
```

**renumberTasks:**
- Three tasks → IDs become T001, T002, T003.
- `dependsOn` references are remapped to new IDs.
- Single task → ID becomes T001.
- Empty array → returns empty array.

**relinkAfterDelete:**
- Task depending on deleted task inherits deleted task's `dependsOn`.
- Task not depending on deleted task is unchanged.
- Deleted task's own `dependsOn` references are not duplicated in the inherited set.

**deleteTask:**
- Deleting middle task removes it, relinkAfterDelete runs, renumber runs, cursor clamps.
- Deleting last task clamps cursor to new last index.
- Deleting only task returns empty array, cursor 0.
- Deleting out-of-range cursor returns unchanged.

**mergeWithPrevious:**
- `cursor === 0` returns error string.
- Tests, steps, constraints concatenate.
- `dependsOn` is union minus curr.id.
- Action is `modify` if either is `modify`.
- Renumber runs after merge.
- Cursor moves to `cursor - 1`.

**moveTaskDown / moveTaskUp:**
- Swaps adjacent elements.
- At boundary returns unchanged.
- Cursor follows the moved task.

**parseSplitResult:**
- Valid single-task markdown returns `[Task]`.
- Zero-task markdown returns `{ error: string }`.
- Multi-task markdown (with `---` separator) returns multiple tasks.

### Verify

```bash
npm test -- src/features/workflow/components/plan-editor/actions.test.ts
npm run typecheck
npm run lint
```

## Constraints

- No classes.
- No imports from `react`, `ink`, or any store.
- ESM `.js` suffix on all imports.
- `parseTasks` import: `import { parseTasks } from '../../../../engine/spec/parser.js'`.
- `topoSort` import: `import { topoSort } from '../../../../core/state/topo-sort.js'`.
- All functions must be pure (same inputs → same outputs, no mutation of inputs).
- `renumberTasks` must be called last (after relinking) in every operation that changes task count.

## Escalation

- If `topo-sort.ts` does not exist at that path, check `src/core/state/` and adjust the import path. Do not create a new sort function.
- If `parseTasks` returns tasks with `status: 'done'` or similar, override `status: 'pending'` in `parseSplitResult` before returning.

## Evidence

- `src/features/workflow/components/plan-editor/actions.ts` created.
- `src/features/workflow/components/plan-editor/actions.test.ts` created with all tests passing.
- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
