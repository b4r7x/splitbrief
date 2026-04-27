# 03 — Plan Editor Component

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Brief 03 of 5. Creates the Ink TUI component for the plan editor and wires it into `WorkflowScreen`. Also adds the `workflow.briefReview` config field and the `'plan-editor-help'` overlay type.

## Intent

Create `src/features/workflow/components/plan-editor.tsx` — a scrollable, cursor-driven task list that reads from `planEditorStore` (brief 01) and renders each task row with status symbols. Mount it in `screen.tsx` when `phase === 'reviewing-briefs'` and `briefReview === 'rich'`. Add the `e`-from-simple-view escape hatch. Keystroke handling is in brief 04.

## Scope

**In bounds:**
- `src/features/workflow/components/plan-editor.tsx` (new file)
- `src/stores/navigation/router.ts` — add `'plan-editor-help'` to `OverlayType` union
- `src/features/workflow/screen.tsx` — add mount branch for plan editor
- Config schema file (find via `src/features/workflow/screen.tsx` imports → `configStore`) — add `workflow.briefReview`
- `docs/CONFIG.md` — document the new config field

**Out of bounds:**
- Keystroke handling — that is brief 04.
- Save logic — that is brief 05.
- Store or action files — created in briefs 01 and 02.
- `brief-review-view.tsx` — do not modify it.

## Code Context

**Mount point:** `src/features/workflow/screen.tsx` lines 127–136

Current branch:
```tsx
{inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
  <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={contentWidth} />
) : inputMode.mode === 'review' && reviewFilePath ? (
  <ReviewView height={contentHeight} width={contentWidth} />
) : (
  <ConversationFlow sections={sections} height={contentHeight} width={contentWidth} />
)}
```

Replace the first branch condition to check `briefReview`:

```tsx
const briefReview = config.workflow.briefReview ?? 'simple';
const runtimeRichMode = planEditorStore.use(s => s.runtimeRichMode);
const useRichEditor = briefReview === 'rich' || runtimeRichMode;

{inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' && useRichEditor ? (
  <PlanEditorComponent filePath={reviewFilePath} height={contentHeight} width={contentWidth} />
) : inputMode.mode === 'review' && reviewFilePath && phase === 'reviewing-briefs' ? (
  <BriefReviewView filePath={reviewFilePath} height={contentHeight} width={contentWidth} />
) : ...
```

**Store pattern:** `src/stores/workflow/review.ts`
**Overlay pattern:** `src/features/workflow/components/cost-drilldown-overlay.tsx` + `src/stores/ui/overlay.ts`
**Theme hook:** `import { useTheme } from '../../../components/theme.js'`
**Store reads:** `.use(selector)` — never `useMemo`.

**OverlayType union** in `src/stores/navigation/router.ts`:
```ts
export type OverlayType =
  | 'none'
  | 'help'
  | 'command-palette'
  | 'skills'
  | 'settings'
  | 'mode-selector'
  | 'planner-picker'
  | 'implementer-picker'
  | 'sessions'
  | 'cost-drilldown';
  // ADD: | 'plan-editor-help'
```

## Implementation Plan

### 1. Add `'plan-editor-help'` to `OverlayType`

In `src/stores/navigation/router.ts`, append `| 'plan-editor-help'` to the union. No other changes to this file.

### 2. Add `workflow.briefReview` to config schema

Find the workflow config schema (likely `src/core/config/schema.ts` or similar — follow imports from `configStore`). Add:

```ts
briefReview: z.enum(['simple', 'rich']).optional().default('simple'),
```

This field is optional with a default so existing config files without it continue to work.

### 3. Create `PlanEditorComponent`

```ts
// src/features/workflow/components/plan-editor.tsx

import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { readFile } from 'node:fs/promises';
import { parseTasks } from '../../../engine/spec/parser.js';
import type { Task } from '../../../core/schemas/task.js';
import type { BriefQualityIssue, BriefQualityReport } from '../../../engine/spec/brief-quality.js';
import { dirname, join } from 'node:path';
```

**Props:**
```ts
interface PlanEditorComponentProps {
  filePath: string;
  height?: number;
  width?: number;
}
```

**On mount:** use `useEffect` to read `filePath`, parse with `parseTasks`, and call `planEditorStore.initEditor(tasks)`. Also read `brief-quality.json` from the same directory (same pattern as `BriefReviewView`). AbortController for cleanup.

**Render structure:**

```
┌─────────────────────────────────────────────────────┐
│ Task Briefs  3 tasks  quality 0.95                  │ ← header row
│ /path/to/tasks.md                                   │ ← file path
│                                                     │
│ > ✓ T001  src/auth.ts   Add login endpoint          │ ← cursor row (highlighted)
│     validation: 3 checks · scope: set               │   detail line
│                                                     │
│   ✓ T002  src/user.ts   Add user model              │ ← normal row
│     validation: 2 checks · scope: set               │
│                                                     │
│ [E] if dirty: unsaved changes                       │ ← dirty indicator
│                                                     │
│ j/k navigate · d delete · m merge · e edit          │ ← hint footer
│ <c-j>/<c-k> reorder · Y save · q discard · ? help  │
└─────────────────────────────────────────────────────┘
```

**Cursor highlight:** use `t.accent` background or bold on the cursor row. Mark with `>` prefix; non-cursor rows get `  ` (two spaces).

**Task row layout:**

```tsx
function TaskEditorRow({ task, isCursor, isExpanded, issues }: {
  task: Task;
  isCursor: boolean;
  isExpanded: boolean;
  issues: BriefQualityIssue[];
}) { ... }
```

Each row:
- prefix: `> ` (cursor) or `  `
- status symbol: `⚠` if any error-severity issue, else `✓`
- status color: `t.error` / `t.success`
- task ID (bold, `t.accent`)
- task file (`t.textDim`)
- task title (`t.text`)
- detail line below (validation count, evidence count, scope present): same format as `buildTaskDetailParts` in `brief-review-view.tsx`

When `isExpanded`, render `TaskEditorDetail` after the row:

```tsx
function TaskEditorDetail({ task }: { task: Task }) { ... }
```

Show `description`, `implementationSteps` (numbered), `tests` (bulleted). Keep it compact — use `t.textDim` for labels.

**Save error:** if `planEditorStore.use(s => s.saveError)` is non-null, render it in `t.error` above the hint footer.

**Dirty indicator:** if `planEditorStore.use(s => s.dirty)`, show `unsaved changes` in `t.warning`.

**Scroll:** the visible task list is sliced to fit `height`. Cursor row is always kept in view. Compute `scrollOffset` locally in the component (not stored) as `Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), tasks.length - visibleRows))`.

### 4. Wire into `screen.tsx`

Add the mount branch as described in Code Context. Import `PlanEditorComponent` and `planEditorStore`. Read `runtimeRichMode` from the store. Read `config.workflow.briefReview` from `configStore`.

### 5. Document the config field

Add to `docs/CONFIG.md` under the `workflow` section:

```
briefReview   'simple' | 'rich'   'simple'   Review mode for Task Briefs during reviewing-briefs phase. 'rich' activates the interactive plan editor for standard/speckit users. Press 'e' from the simple view to activate rich mode for the current session without changing this setting.
```

## Validation

No component mount tests are required for this brief. Verify integration by:

- Running `npm run typecheck` — the new component props and config field must type-check.
- Running `npm run lint` — no lint errors.
- The `OverlayType` union must compile with `'plan-editor-help'` added.
- Running existing tests to confirm nothing was broken: `npm test`.

Spot-check the mount logic manually:

1. `briefReview === 'simple'` (default) + `runtimeRichMode === false` → `BriefReviewView` mounts.
2. `briefReview === 'rich'` → `PlanEditorComponent` mounts.
3. `briefReview === 'simple'` + `runtimeRichMode === true` → `PlanEditorComponent` mounts.

## Constraints

- Do NOT call `usePlanEditorKeys` from within `PlanEditorComponent` in this brief. Keystroke wiring is added by brief 04. The component must render and mount cleanly without it.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- No classes.
- No barrel exports (do not create `src/features/workflow/components/plan-editor/index.ts`).
- ESM `.js` suffix on all imports.
- `TaskEditorRow` and `TaskEditorDetail` are not exported — they are internal to `plan-editor.tsx`.
- The scroll offset computation is local to the component render — do not store it in `planEditorStore`.
- Do not add `'plan-editor-help'` to any allowlist or overlay rendering logic yet — that is brief 04.

## Escalation

- If the config schema file location is unclear, grep for `briefReview` or look at `configStore` usage in `screen.tsx` to find the schema import chain.
- If `config.workflow` type does not yet include `briefReview`, the typecheck will fail with a clear error pointing to the field. Fix only that schema file.
- If `useTheme` is not available, import from `src/components/theme.js`.

## Evidence

- `src/features/workflow/components/plan-editor.tsx` created.
- `src/stores/navigation/router.ts` updated with `'plan-editor-help'` in union.
- Config schema updated with `workflow.briefReview`.
- `src/features/workflow/screen.tsx` updated with mount branch.
- `docs/CONFIG.md` updated.
- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
- `npm test` exits 0 (existing tests unbroken).
