# 05 — Save and Commit

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Brief 05 of 5. Implements the atomic save flow (`Y`), the external editor open/close (`e`/`s`), and the one targeted engine change to `runBriefsApprovalLoop` that makes the implementation path receive the user-edited tasks rather than the planner's in-memory list.

## Intent

Create `src/features/workflow/hooks/use-plan-editor-save.ts` — async save handler. Create `src/features/workflow/components/plan-editor/external-editor.ts` — external editor open/close logic. Patch `src/engine/orchestrator/planning/shared.ts` (`runBriefsApprovalLoop`) to re-parse `tasks.md` after `onApprovalNeeded` resolves with `approved: true`. Create `src/engine/spec/formatter.ts` if it does not exist — `formatTasks(tasks: Task[]): string` is required for the save path.

## Scope

**In bounds:**
- `src/features/workflow/hooks/use-plan-editor-save.ts` (new file)
- `src/features/workflow/hooks/use-plan-editor-save.test.ts` (new file, colocated)
- `src/features/workflow/components/plan-editor/external-editor.ts` (new file)
- `src/features/workflow/components/plan-editor/external-editor.test.ts` (new file, colocated)
- `src/engine/spec/formatter.ts` — new file if it does not exist; targeted addition if it does
- `src/engine/spec/formatter.test.ts` — new or extend existing
- `src/engine/orchestrator/planning/shared.ts` — targeted patch to `runBriefsApprovalLoop`
- `src/features/workflow/hooks/use-plan-editor-keys.ts` — replace stub `openExternalEditor` with real implementation (import from `external-editor.ts`)

**Out of bounds:**
- Do not modify the engine state machine (`src/core/state/machine.ts`).
- Do not modify `brief-review-view.tsx`.
- Do not change any other orchestrator file beyond the single targeted change in `runBriefsApprovalLoop`.

## Code Context

**`runBriefsApprovalLoop`** in `src/engine/orchestrator/planning/shared.ts` (lines 224–268):

```ts
// Current (simplified):
while (true) {
  const result = await callbacks.onApprovalNeeded('briefs', tasksFilePath);
  if (!result.approved && !result.comment) {
    state = transitionAndSave(..., { type: 'REJECT_BRIEFS' });
    return { state, tasks, rejected: true };
  }
  if (!result.comment) {
    state = transitionAndSave(..., { type: 'APPROVE_BRIEFS' });
    return { state, tasks, rejected: false };  // ← tasks is still the planner's list
  }
  // comment path: regenerate and loop
}
```

**Targeted change:** on the `result.approved && !result.comment` branch (approve path), re-read and re-parse `tasksFilePath` before dispatching `APPROVE_BRIEFS`:

```ts
if (!result.comment) {
  // Re-read from disk so any user edits (e.g. via plan editor) are reflected.
  const editedText = await readFile(tasksFilePath, 'utf8').catch(() => null);
  if (editedText !== null) {
    const editedTasks = parseTasks(editedText);
    if (editedTasks.length > 0) {
      tasks = editedTasks;
    }
  }
  state = transitionAndSave(projectDir, sessionId, state, { type: 'APPROVE_BRIEFS' });
  return { state, tasks, rejected: false };
}
```

Imports needed: `import { readFile } from 'node:fs/promises'` and `import { parseTasks } from '../../spec/parser.js'` (check if already present; add only what is missing).

**`writeSpecFile`** in `src/core/paths-io.ts` — exists. Use it to write `tasks.md` and `brief-quality.json`.

**`sessionDir`** from `src/core/paths.ts`:
```ts
export const sessionDir = (projectDir: string, sessionId: string): string => join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
```

**`evaluateBriefQuality`** from `src/engine/spec/brief-quality.ts`:
```ts
export function evaluateBriefQuality(tasks: Task[]): BriefQualityReport;
```

**`parseTasks`** from `src/engine/spec/parser.ts`:
```ts
export function parseTasks(tasksMarkdown: string): Task[];
```

**`planEditorStore`** from `src/stores/workflow/plan-editor.js`:
```ts
planEditorStore.get().tasks   // current in-memory task list
planEditorStore.markSaved()   // sets dirty: false, saveError: null
planEditorStore.setSaveError(msg)
```

## Implementation Plan

### 1. Create `formatTasks` serializer

```ts
// src/engine/spec/formatter.ts
export function formatTasks(tasks: Task[]): string
```

This is the inverse of `parseTasks`. It serializes a `Task[]` back to the `tasks.md` markdown format the parser can round-trip.

Check first whether `src/engine/spec/formatter.ts` already exists. If it does, check if `formatTasks` is exported. Add it if missing.

If it does not exist, create it. The format must match what `parseTasks` expects:

```
---
id: T001
title: Add login endpoint
action: modify
file: src/auth/login.ts
depends_on: []
---

## Description

[task.description]

## Implementation Steps

1. [step 1]
2. [step 2]

## Tests

- [test 1]

## Constraints

- [constraint 1]

## Type Definitions

[task.typeDefs if non-empty]

## Escalation

- [escalation rule] (if present)

## Evidence

- [evidence item] (if present)

---
[next task...]
```

The header is YAML frontmatter inside `---` delimiters. The body sections match what `parseTasks` parses. Look at `src/engine/spec/parser.ts` carefully to determine the exact section heading names and ordering expected.

### 2. Create `external-editor.ts`

```ts
// src/features/workflow/components/plan-editor/external-editor.ts

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../../../core/schemas/task.js';
import { parseTasks } from '../../../../engine/spec/parser.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { renumberTasks } from './actions.js';
import { planEditorStore } from '../../../../stores/workflow/plan-editor.js';

export function openExternalEditor(
  task: Task,
  mode: 'edit' | 'split',
  sessionDirPath: string,
): void
```

Algorithm:

1. Determine `$EDITOR` (or `vi` as fallback).
2. Write a temp file:
   - For `'edit'`: write `formatTasks([task])` to `<sessionDirPath>/edit-<task.id>.md`.
   - For `'split'`: write `formatTasks([task])` to `<sessionDirPath>/split-<task.id>.md` with an instruction comment at the top: `# To split: add a --- separator followed by complete frontmatter (id/title/action/file) for each additional task. This uses the standard tasks.md format.`.
3. `process.stdin.pause()`.
4. `spawnSync(editor, [tmpPath], { stdio: 'inherit' })`.
5. `process.stdin.resume()`.
6. Read back the temp file.
7. Parse with `parseTasks(content)`.
8. For `'edit'`: if exactly one task parsed, replace the cursor task in the store's task list. If parse fails or returns 0 tasks, call `planEditorStore.setSaveError('Editor returned no valid task')` and return.
9. For `'split'`: if 1+ tasks parsed, replace the cursor task with the parsed list at the cursor position. If parse fails, set save error.
10. In both cases: call `renumberTasks` on the updated full task list, then `planEditorStore.setTasks(result)`.
11. Clean up the temp file (`unlinkSync` — ignore errors).
12. If `$EDITOR` and `vi` both fail (spawnSync status is non-zero or error), call `planEditorStore.setSaveError('Editor not found. Set $EDITOR.')` and return.

Note: `spawnSync` blocks synchronously. This is intentional (see ADR-012 in `decisions.md`).

### 3. Update the stub in `use-plan-editor-keys.ts`

Replace:

```ts
async function openExternalEditor(...): Promise<void> { /* stub */ }
```

With:

```ts
import { openExternalEditor } from '../components/plan-editor/external-editor.js';
```

And update the call site in `usePlanEditorKeys`:

```ts
if (action.type === 'open-editor') {
  const { tasks, cursor } = planEditorStore.get();
  const task = tasks[cursor];
  if (!task) return;
  openExternalEditor(task, action.mode, sessionDirPath);
  return;
}
```

Note: `openExternalEditor` is now synchronous (blocks via `spawnSync`). Remove the `void` prefix and `async` wrapper if present.

### 4. Create `use-plan-editor-save.ts`

```ts
// src/features/workflow/hooks/use-plan-editor-save.ts

import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTasks } from '../../../engine/spec/parser.js';
import { formatTasks } from '../../../engine/spec/formatter.js';
import { evaluateBriefQuality } from '../../../engine/spec/brief-quality.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { TASKS_FILE, BRIEF_QUALITY_FILE } from '../../../core/paths.js';

export function createSaveHandler(
  sessionDirPath: string,
  onApprove: () => void,
): () => Promise<void>
```

Returns an async function that performs the atomic save:

```ts
return async function save() {
  const { tasks } = planEditorStore.get();
  const markdown = formatTasks(tasks);
  const tasksPath = join(sessionDirPath, TASKS_FILE);
  const tmpPath = `${tasksPath}.tmp`;

  // Write to temp
  await writeFile(tmpPath, markdown, { encoding: 'utf8', mode: 0o600 });

  // Round-trip validation
  const roundTripped = parseTasks(markdown);
  const expectedIds = new Set(tasks.map(t => t.id));
  const actualIds = new Set(roundTripped.map(t => t.id));
  const mismatch =
    roundTripped.length !== tasks.length ||
    [...expectedIds].some(id => !actualIds.has(id));

  if (mismatch) {
    // Clean up temp
    await unlink(tmpPath).catch(() => {});
    planEditorStore.setSaveError(
      `Save aborted: serialized tasks did not round-trip correctly (${roundTripped.length} vs ${tasks.length} tasks). Please report this bug.`,
    );
    return;
  }

  // Atomic rename
  await rename(tmpPath, tasksPath);

  // Regenerate brief-quality.json
  const report = evaluateBriefQuality(tasks);
  const qualityPath = join(sessionDirPath, BRIEF_QUALITY_FILE);
  await writeFile(qualityPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });

  // Mark saved and signal the engine loop
  planEditorStore.markSaved();
  onApprove();
};
```

`onApprove` is the callback the `WorkflowScreen` provides to signal the `callbacks.onApprovalNeeded` resolver. How to connect:

The `PlanEditorComponent` receives an `onSave` prop from `WorkflowScreen`. In `WorkflowScreen`, the approval callback is already managed by `useWorkflowRunner`. The approval flow works through the `reviewStore` / `callbacks.onApprovalNeeded` promise. The component calls `createSaveHandler(sessionDirPath, onApprove)` where `onApprove` calls the existing approval callback that `useWorkflowRunner` exposes.

Look at how `BriefReviewView` and the review parser (`src/features/workflow/review-parser.ts`) integrate with `useWorkflowRunner` to understand how `onApprovalNeeded` is resolved on approve. The plan editor save must resolve the same promise with `{ approved: true }`.

If the runner exposes a `handleApprove()` function (or similar), call it. If the approval is resolved via the input bar's `onSubmit` path, replicate that path from the save handler. Do not bypass the existing approval resolution mechanism.

### 5. Wire `createSaveHandler` into `PlanEditorComponent`

In `plan-editor.tsx` (brief 03), add props:

```ts
interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
  sessionDirPath: string;
  onApprove: () => void;
}
```

Inside `PlanEditorComponent`:

```ts
const save = createSaveHandler(sessionDirPath, onApprove);
usePlanEditorKeys(true, save, sessionDirPath);
```

### 6. Engine change: re-parse in `runBriefsApprovalLoop`

In `src/engine/orchestrator/planning/shared.ts`, in the `runBriefsApprovalLoop` function, on the approve path (lines around 241–244), add the re-parse before `APPROVE_BRIEFS`:

```ts
if (!result.comment) {
  // Re-read tasks.md from disk: the plan editor may have written an edited version.
  try {
    const { readFile } = await import('node:fs/promises');
    const editedText = await readFile(tasksFilePath, 'utf8');
    const editedTasks = parseTasks(editedText);
    if (editedTasks.length > 0) tasks = editedTasks;
  } catch {
    // File unreadable — proceed with in-memory tasks.
  }
  state = transitionAndSave(projectDir, sessionId, state, { type: 'APPROVE_BRIEFS' });
  return { state, tasks, rejected: false };
}
```

If `readFile` is already imported at the top of the file, use the static import. Prefer static import over dynamic `import()`. Add `import { readFile } from 'node:fs/promises'` to the top-of-file imports if not present. `parseTasks` must also be imported — check if it is already imported; add if not.

## Validation

### Tests in `use-plan-editor-save.test.ts`

Use a temp directory via `import { mkdtemp, rm, readFile } from 'node:fs/promises'` and `import { tmpdir } from 'node:os'`.

- **Happy path:** given a valid `Task[]`, `createSaveHandler` writes `tasks.md` and `brief-quality.json` to the temp dir, and calls `onApprove`.
- **Round-trip check:** the written `tasks.md` parses back to the same task count and IDs.
- **Validation failure:** if `formatTasks` is mocked to return unparseable content, `onApprove` is NOT called, `setSaveError` is called, and `tasks.md` is not written.
- **Brief-quality JSON:** after save, `brief-quality.json` is valid JSON with a `passed` field.

### Tests in `external-editor.test.ts`

These tests may be thin given the `spawnSync` dependency. Mock `spawnSync` and filesystem operations.

- `openExternalEditor` with `mode: 'edit'` writes a temp file containing the task markdown and reads it back after the mock editor exits.
- If `spawnSync` returns non-zero status, `planEditorStore.setSaveError` is called.
- For `mode: 'split'`, the comment instruction line is present in the written temp file.

### Tests for `formatTasks` in `formatter.test.ts`

- `formatTasks([task])` round-trips through `parseTasks`: `parseTasks(formatTasks([task]))[0].id === task.id`.
- `formatTasks([t1, t2])` produces a string that `parseTasks` returns as two tasks.
- `formatTasks([])` returns empty string or string that `parseTasks` returns as `[]`.

### Verify

```bash
npm test -- src/features/workflow/hooks/use-plan-editor-save.test.ts
npm test -- src/features/workflow/components/plan-editor/external-editor.test.ts
npm test -- src/engine/spec/formatter.test.ts
npm run typecheck
npm run lint
npm test
```

## Constraints

- No classes.
- No barrel exports.
- ESM `.js` suffix on all imports.
- `formatTasks` lives in `src/engine/spec/formatter.ts`. Engine code — no React/Ink imports.
- `external-editor.ts` lives in `src/features/` — it may import from `src/engine/spec/` but must not import `react` or `ink` directly.
- `use-plan-editor-save.ts` lives in `src/features/workflow/hooks/` — it may import from `src/engine/spec/` and `src/stores/`.
- The `unlink` import in the save handler: `import { writeFile, rename, unlink } from 'node:fs/promises'`.
- File permissions: all written files use `mode: 0o600` (matching existing session file convention).
- The engine change to `runBriefsApprovalLoop` must remain backward-compatible: if the tasks file is absent or unreadable, the existing in-memory tasks are used unchanged. No new errors are thrown.

## Escalation

- If `formatTasks` already exists with a different signature, adapt the save handler to use whatever serializer is available. Do not create a duplicate.
- If the approval resolution mechanism is opaque (cannot find how `callbacks.onApprovalNeeded` is resolved from the UI side), look at `src/features/workflow/hooks/use-workflow-runner.ts` for the `onApprovalNeeded` implementation and how its Promise is resolved when the user types `approve` in the input bar.
- If static import of `readFile` conflicts with an existing dynamic import in `shared.ts`, use whatever pattern is consistent with the file. Prefer static imports.
- If `parseTasks` is already imported in `shared.ts` (it may be), skip adding a duplicate import.

## Evidence

- `src/features/workflow/hooks/use-plan-editor-save.ts` created.
- `src/features/workflow/hooks/use-plan-editor-save.test.ts` created, tests passing.
- `src/features/workflow/components/plan-editor/external-editor.ts` created.
- `src/features/workflow/components/plan-editor/external-editor.test.ts` created, tests passing.
- `src/engine/spec/formatter.ts` created or updated with `formatTasks`.
- `src/engine/spec/formatter.test.ts` created or updated, round-trip tests passing.
- `src/engine/orchestrator/planning/shared.ts` patched with re-parse on approve path.
- `src/features/workflow/hooks/use-plan-editor-keys.ts` updated to import `openExternalEditor` from `external-editor.ts` (replacing the stub).
- `npm run test-ci` exits 0 (typecheck → lint → test).
