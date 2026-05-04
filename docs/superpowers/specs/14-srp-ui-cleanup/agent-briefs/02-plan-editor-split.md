# 02 — Split plan-editor.tsx within workflow/components/

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Split `src/features/workflow/components/plan-editor.tsx` (514 LOC, 1 main component + 6 sub-components/helpers, 4 concerns) into focused siblings. The `plan-editor/` folder already exists with `actions.ts`, `external-editor.ts`, `help-overlay.tsx` — add new siblings there.

## Required Skills

- `/clean-code`
- `/test-behavior-not-implementation`
- `/coding-standards`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/features/workflow/components/plan-editor.tsx` — full file
- `src/features/workflow/components/plan-editor/` — existing folder contents
- `src/features/workflow/components/plan-editor-footer.tsx` — existing sibling
- `src/stores/workflow/plan-editor.ts` — store interface

## Write Ownership

```
src/features/workflow/components/plan-editor.tsx                    (rewrite — main component only)
src/features/workflow/components/plan-editor/task-row.tsx           (create — TaskEditorRow + TaskEditorDetail)
src/features/workflow/components/plan-editor/preview-panel.tsx      (create — WorkerPacketPreviewPanel)
src/features/workflow/components/plan-editor/virtualization.ts      (create — visible window calculation)
src/features/workflow/components/plan-editor/loader.ts              (create — file loading + parsing)
```

## Required Behavior

### Part A: Create virtualization.ts — task list windowing

Move pure layout functions:
- `getTaskEditorRowHeight()` — computes row height based on expansion state and metadata
- `getVisibleTaskWindow()` — calculates which tasks fit in viewport given cursor position
- Types: `VisibleTaskWindow`

These are pure functions with no React dependency. Input: tasks, cursor, expanded set, metadata, row budget. Output: window slice.

~70 LOC.

### Part B: Create task-row.tsx — task row components

Move:
- `TaskEditorRow()` — renders single task with status symbol, flags, details
- `TaskEditorDetail()` — renders expanded task view with review metadata
- `DetailList()` — reusable detail section renderer (label + items)
- Helpers: `compactValue()`, `compactExcerpt()`, `taskWithoutCurrentCode()`

These are self-contained presentation components. They receive data via props — no store access.

~160 LOC.

### Part C: Create preview-panel.tsx — worker packet preview

Move:
- `WorkerPacketPreviewPanel()` component
- `buildPreviewNoticeLine()` helper
- The packet refresh useEffect logic (currently lines ~363-429) — extract as a custom hook `usePacketPreview()` or keep as an effect inside the panel

~80 LOC.

### Part D: Create loader.ts — plan file loading

Move the file loading logic from the main useEffect (currently lines ~312-350):
- `loadPlanEditorData()` — reads tasks.md + brief-quality.json, parses, initializes store

```typescript
export async function loadPlanEditorData(opts: {
  filePath: string;
  sessionDirPath: string;
}): Promise<{
  tasks: Task[];
  quality: BriefQualityReport | null;
}> {
  const raw = await readFile(opts.filePath, 'utf8');
  const tasks = parseTasks(raw);
  // ... quality loading
  return { tasks, quality };
}
```

~40 LOC.

### Part E: Rewrite plan-editor.tsx

After extraction, the main component becomes a composition shell:

```tsx
import { TaskEditorRow } from './plan-editor/task-row.js';
import { WorkerPacketPreviewPanel } from './plan-editor/preview-panel.js';
import { getVisibleTaskWindow } from './plan-editor/virtualization.js';
import { loadPlanEditorData } from './plan-editor/loader.js';

export function PlanEditorComponent(props: PlanEditorComponentProps): ReactNode {
  // State initialization
  // Load effect → loadPlanEditorData()
  // Keyboard binding
  // Visible window calculation
  // Render: header → task rows → preview panel → footer
}
```

Target: ~150 LOC — only orchestration and layout.

Final structure:
```
plan-editor/
├── actions.ts            (existing — unchanged)
├── external-editor.ts    (existing — unchanged)
├── help-overlay.tsx       (existing — unchanged)
├── task-row.tsx           (~160 LOC — row components)
├── preview-panel.tsx      (~80 LOC — preview component)
├── virtualization.ts      (~70 LOC — windowing math)
├── loader.ts              (~40 LOC — file loading)
```

And the parent entry stays at:
```
plan-editor.tsx            (~150 LOC — main component)
plan-editor-footer.tsx     (existing — unchanged)
```

## Tests

- `virtualization.test.ts` — test `getVisibleTaskWindow` with various cursor positions and expanded states
- `loader.test.ts` — test `loadPlanEditorData` with mock file content (if non-trivial)
- Keep existing plan-editor tests if they exist

## Verification

- [ ] `plan-editor.tsx` is ≤160 LOC
- [ ] TaskEditorRow renders identically (visual regression check)
- [ ] Plan editor keyboard shortcuts still work
- [ ] Preview panel refresh still works
- [ ] `npm run test-ci` passes
