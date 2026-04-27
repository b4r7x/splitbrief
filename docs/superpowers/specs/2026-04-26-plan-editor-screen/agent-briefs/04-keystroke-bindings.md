# 04 — Keystroke Bindings

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Brief 04 of 5. Creates the keystroke handler for the plan editor and the help overlay. This brief does not implement save (`Y`) — save is brief 05. This brief does not implement the component rendering — that is brief 03.

## Intent

Create `src/features/workflow/hooks/use-plan-editor-keys.ts` — a `useInput` hook that is active only when the plan editor is mounted. It reads from `planEditorStore` (brief 01), calls action functions from `actions.ts` (brief 02), dispatches to `planEditorStore.setTasks(...)`, and manages the help overlay via `overlayStore`. Create `src/features/workflow/components/plan-editor-help-overlay.tsx` — the `?` help overlay.

## Scope

**In bounds:**
- `src/features/workflow/hooks/use-plan-editor-keys.ts` (new file)
- `src/features/workflow/hooks/use-plan-editor-keys.test.ts` (new file, colocated)
- `src/features/workflow/components/plan-editor-help-overlay.tsx` (new file)
- `src/features/workflow/screen.tsx` — add `<PlanEditorHelpOverlay />` render + `usePlanEditorKeys()` call
- `src/features/workflow/components/plan-editor.tsx` — call `usePlanEditorKeys()` from within the component

**Out of bounds:**
- `Y` (save) — brief 05.
- Component rendering — brief 03.
- Store or action files — briefs 01 and 02.
- External editor open/close for `e` full-edit: this brief handles the `e` keystroke by calling a placeholder `openExternalEditor(task, 'edit')` function that is fully implemented in brief 05. Stub it here as `async function openExternalEditor(_task: Task, _mode: 'edit' | 'split'): Promise<void> { /* implemented in brief 05 */ }`.

## Code Context

**Keystroke handler pattern:** `src/features/workflow/hooks/use-workflow-keys.ts`

The pattern is: pure handler function returns an action variant; `applyAction` dispatches to stores. `useInput` calls the handler and applies the result.

```ts
// Pattern from use-workflow-keys.ts
function applyAction(action: WorkflowKeyAction) {
  switch (action.type) {
    case 'none': return;
    case 'navigate-home': routerStore.navigate({ to: 'home' }); return;
    ...
  }
}
```

**Action functions (brief 02):**
```ts
import { deleteTask, mergeWithPrevious, moveTaskDown, moveTaskUp, parseSplitResult } from '../components/plan-editor/actions.js';
```

**Store (brief 01):**
```ts
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
```

**Overlay store:**
```ts
import { overlayStore } from '../../../stores/ui/overlay.js';
// overlayStore.open('plan-editor-help') / overlayStore.close()
```

**`useInput` from Ink:**
```ts
import { useInput, type Key } from 'ink';
// isActive: boolean controls whether this handler captures input
```

**Help overlay pattern:** `src/features/workflow/components/cost-drilldown-overlay.tsx`
Uses `OverlayPanel` from `src/components/overlays/overlay-panel.js`.

## Implementation Plan

### 1. Define the plan editor action variant

```ts
// src/features/workflow/hooks/use-plan-editor-keys.ts

export type PlanEditorAction =
  | { type: 'none' }
  | { type: 'move-cursor'; direction: 'up' | 'down' }
  | { type: 'move-task'; direction: 'up' | 'down' }
  | { type: 'delete-task' }
  | { type: 'merge-task' }
  | { type: 'toggle-expand' }
  | { type: 'open-help' }
  | { type: 'open-editor'; mode: 'edit' | 'split' }
  | { type: 'save' }
  | { type: 'discard' };
```

### 2. Implement the pure handler

```ts
export function handlePlanEditorInput(input: string, key: Key): PlanEditorAction
```

This function has no side effects. It maps raw key events to action variants.

| Input | Key | Action |
|---|---|---|
| `'j'` | — | `move-cursor down` |
| `'k'` | — | `move-cursor up` |
| — | `key.downArrow` | `move-cursor down` |
| — | `key.upArrow` | `move-cursor up` |
| — | `key.ctrl && input === 'j'` | `move-task down` |
| — | `key.ctrl && input === 'k'` | `move-task up` |
| — | `key.ctrl && input === 'n'` | `move-task down` |
| — | `key.ctrl && input === 'p'` | `move-task up` |
| `'d'` | — | `delete-task` |
| `'m'` | — | `merge-task` |
| `'s'` | — | `open-editor split` |
| `'e'` | — | `open-editor edit` |
| — | `key.return` | `toggle-expand` |
| `'?'` | — | `open-help` |
| `'Y'` | — (capital Y, shift+y) | `save` |
| `'q'` | — | `discard` |
| any other | — | `none` |

Note on detecting capital `Y`: in Ink's `useInput`, the `input` string is `'Y'` when the user presses shift+y. No special `key` flag needed.

Note on ctrl chords: `key.ctrl === true && input === 'j'` detects `<c-j>`. Verify against the existing `handleWorkflowCtrlChords` in `src/features/workflow/keyboard.ts` to avoid conflicts.

### 3. Implement `applyPlanEditorAction`

```ts
export function applyPlanEditorAction(
  action: PlanEditorAction,
  onSave: () => Promise<void>,
): void
```

This function reads the current state from `planEditorStore.get()`, applies the action, and dispatches to the store.

```
move-cursor   → planEditorStore.moveCursor(direction)

move-task     → const { tasks, cursor } = planEditorStore.get()
                const result = direction === 'down' ? moveTaskDown(tasks, cursor) : moveTaskUp(tasks, cursor)
                planEditorStore.setTasks(result.tasks)
                planEditorStore.moveCursor(result.cursor - cursor > 0 ? 'down' : 'up')
                // Note: setTasks always marks dirty. For reorder, this is correct.

delete-task   → const { tasks, cursor } = planEditorStore.get()
                const result = deleteTask(tasks, cursor)
                planEditorStore.setTasks(result.tasks)
                planEditorStore.setCursor(result.cursor)

merge-task    → const { tasks, cursor } = planEditorStore.get()
                const result = mergeWithPrevious(tasks, cursor)
                if (result.error) { planEditorStore.setSaveError(result.error); return; }
                planEditorStore.setTasks(result.tasks)
                planEditorStore.setCursor(result.cursor)

toggle-expand → const { tasks, cursor } = planEditorStore.get()
                const task = tasks[cursor]
                if (task) planEditorStore.toggleExpand(task.id)

open-help     → overlayStore.open('plan-editor-help')

open-editor   → handled async in the hook body (see step 4)

save          → onSave() (async, provided by brief 05 caller)

discard       → planEditorStore.setRuntimeRichMode(false)
                planEditorStore.reset()
                // This causes screen.tsx to fall back to BriefReviewView
```

### 4. Implement `usePlanEditorKeys`

```ts
export function usePlanEditorKeys(
  isActive: boolean,
  onSave: () => Promise<void>,
  sessionDir: string,
): void {
  const isOverlayOpen = overlayStore.use(s => s.active !== 'none');

  useInput(
    (_input, _key) => { overlayStore.close(); },
    { isActive: overlayStore.use(s => s.active === 'plan-editor-help') },
  );

  useInput(
    (input, key) => {
      const action = handlePlanEditorInput(input, key);
      if (action.type === 'open-editor') {
        const { tasks, cursor } = planEditorStore.get();
        const task = tasks[cursor];
        if (!task) return;
        void openExternalEditor(task, action.mode, sessionDir, planEditorStore);
        return;
      }
      applyPlanEditorAction(action, onSave);
    },
    { isActive: isActive && !isOverlayOpen },
  );
}
```

The `openExternalEditor` function is stubbed in this brief:

```ts
async function openExternalEditor(
  task: Task,
  mode: 'edit' | 'split',
  sessionDir: string,
  store: typeof planEditorStore,
): Promise<void> {
  // Implemented in brief 05.
  // Stub: no-op.
}
```

Brief 05 will replace this stub with the real implementation in the same file, or import it from a helper.

Call `usePlanEditorKeys` from within `PlanEditorComponent` (brief 03):

```tsx
// In plan-editor.tsx:
import { usePlanEditorKeys } from '../hooks/use-plan-editor-keys.js';
// Inside PlanEditorComponent:
usePlanEditorKeys(true, onSave, sessionDirPath);
// onSave and sessionDirPath are provided as props or derived from filePath.
```

### 5. Create `PlanEditorHelpOverlay`

```tsx
// src/features/workflow/components/plan-editor-help-overlay.tsx

import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { OverlayPanel } from '../../../components/overlays/overlay-panel.js';
import { overlayStore } from '../../../stores/ui/overlay.js';

const HELP_ROWS: Array<[string, string]> = [
  ['j / ↓', 'Move cursor down'],
  ['k / ↑', 'Move cursor up'],
  ['<c-j> / <c-n>', 'Move task down'],
  ['<c-k> / <c-p>', 'Move task up'],
  ['d', 'Delete task'],
  ['m', 'Merge with previous task'],
  ['s', 'Split task (opens $EDITOR)'],
  ['e', 'Edit task in $EDITOR'],
  ['<enter>', 'Expand / collapse task body'],
  ['Y', 'Save changes and proceed'],
  ['q', 'Discard changes and return'],
  ['?', 'Show / hide this help'],
];

export function PlanEditorHelpOverlay() {
  const t = useTheme();
  const isActive = overlayStore.use(s => s.active === 'plan-editor-help');
  if (!isActive) return null;

  return (
    <OverlayPanel title="Plan Editor Keys" hint="press any key to dismiss" width="auto">
      <Box flexDirection="column">
        {HELP_ROWS.map(([key, desc]) => (
          <Box key={key} gap={2}>
            <Text color={t.accent}>{key.padEnd(16)}</Text>
            <Text color={t.text}>{desc}</Text>
          </Box>
        ))}
      </Box>
    </OverlayPanel>
  );
}
```

Mount `<PlanEditorHelpOverlay />` in `screen.tsx` alongside the existing overlay renders. Find where `CostDrilldownOverlay` is rendered and add `PlanEditorHelpOverlay` in the same location.

## Validation

### Tests in `use-plan-editor-keys.test.ts`

Test `handlePlanEditorInput` directly — no React, no `useInput` mounting.

```ts
import { describe, it, expect } from 'vitest';
import { handlePlanEditorInput } from './use-plan-editor-keys.js';
// Key type mock:
const noKey = { ctrl: false, meta: false, shift: false, return: false, escape: false, tab: false, backspace: false, delete: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, f1: false, f2: false, f3: false, f4: false, f5: false, f6: false, f7: false, f8: false, f9: false, f10: false, f11: false, f12: false };
```

- `'j'`, no modifiers → `{ type: 'move-cursor', direction: 'down' }`
- `'k'` → `{ type: 'move-cursor', direction: 'up' }`
- `downArrow` key → `move-cursor down`
- `upArrow` key → `move-cursor up`
- ctrl+j → `move-task down`
- ctrl+k → `move-task up`
- ctrl+n → `move-task down`
- ctrl+p → `move-task up`
- `'d'` → `delete-task`
- `'m'` → `merge-task`
- `'s'` → `{ type: 'open-editor', mode: 'split' }`
- `'e'` → `{ type: 'open-editor', mode: 'edit' }`
- `return` key → `toggle-expand`
- `'?'` → `open-help`
- `'Y'` (capital) → `save`
- `'y'` (lowercase) → `none`
- `'q'` → `discard`
- any unrecognized input → `none`

### Verify

```bash
npm test -- src/features/workflow/hooks/use-plan-editor-keys.test.ts
npm run typecheck
npm run lint
```

## Constraints

- No classes.
- No barrel exports.
- ESM `.js` suffix on all imports.
- `handlePlanEditorInput` must be a pure exported function (no store reads) so it is directly testable.
- `applyPlanEditorAction` reads from `planEditorStore.get()` — do not pass the state as a parameter (this matches the existing `applyAction` pattern in `use-workflow-keys.ts`).
- The `isActive` prop to `usePlanEditorKeys` must be threaded through `useInput`'s `isActive` option so the hook never captures keys when another screen is active.
- `void openExternalEditor(...)` — use void to suppress floating-promise lint warnings. Brief 05 provides the implementation.

## Escalation

- If `OverlayPanel` is not at `src/components/overlays/overlay-panel.js`, find it by grepping for its usage in `cost-drilldown-overlay.tsx`.
- If `setCursor` is missing from `planEditorStore`, add it following the `moveCursor` pattern in brief 01. The action sets `cursor` to an absolute index (clamped), not a direction delta.
- If ctrl chord detection conflicts with existing `handleWorkflowCtrlChords`, note that `usePlanEditorKeys` is only active (`isActive: true`) when the plan editor is mounted. The existing `useWorkflowKeys` in `screen.tsx` must be `isActive: false` when the plan editor is mounted. Check `useWorkflowKeys` — it already gates on `!isOpen` (overlay). Add a second gate: `!useRichEditorActive` where `useRichEditorActive = phase === 'reviewing-briefs' && useRichEditor`.

## Evidence

- `src/features/workflow/hooks/use-plan-editor-keys.ts` created.
- `src/features/workflow/hooks/use-plan-editor-keys.test.ts` created with all keystroke tests passing.
- `src/features/workflow/components/plan-editor-help-overlay.tsx` created.
- `screen.tsx` updated with `<PlanEditorHelpOverlay />` render.
- `plan-editor.tsx` updated with `usePlanEditorKeys(...)` call.
- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
- `npm test` exits 0.
