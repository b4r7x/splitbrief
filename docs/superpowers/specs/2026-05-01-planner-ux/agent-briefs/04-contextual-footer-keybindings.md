# 04 - Contextual Footer Keybindings

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Replace the static two-line footer in the plan editor with a contextual footer that shows only the keybindings relevant to the current editor state. Users should immediately see what actions are available without pressing `?`.

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
- `src/features/workflow/components/plan-editor.tsx`
- `src/features/workflow/hooks/use-plan-editor-keys.ts`

## Write Ownership

Primary files:

```text
src/features/workflow/components/plan-editor-footer.tsx (new)
src/features/workflow/components/plan-editor-footer.test.ts (new)
src/features/workflow/components/plan-editor.tsx (modify — replace inline footer)
```

Do not edit streaming files. Do not edit heartbeat files. Do not edit regeneration engine files.

## Design

### Footer Component

Create `src/features/workflow/components/plan-editor-footer.tsx`:

```tsx
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';

interface FooterBinding {
  key: string;
  label: string;
}

function getContextualBindings(state: {
  tasks: { length: number };
  cursor: number;
  dirty: boolean;
  flaggedIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  isPacketPreviewOpen: boolean;
}): FooterBinding[] {
  const bindings: FooterBinding[] = [];
  const hasTasks = state.tasks.length > 0;
  const hasFlagged = state.flaggedIds.size > 0;
  const currentTaskId = hasTasks ? undefined : undefined; // cursor presence implies task exists

  // Navigation (always available when tasks exist)
  if (hasTasks) {
    bindings.push({ key: 'j/k', label: 'navigate' });
  }

  // Task actions (available when cursor is on a task)
  if (hasTasks) {
    bindings.push({ key: 'enter', label: 'expand' });
    bindings.push({ key: 'x', label: 'flag' });
    bindings.push({ key: 'e', label: 'edit' });
    bindings.push({ key: 's', label: 'split' });
    bindings.push({ key: 'd', label: 'delete' });
  }

  // Merge requires cursor > 0
  if (hasTasks && state.cursor > 0) {
    bindings.push({ key: 'm', label: 'merge' });
  }

  // Reorder requires multiple tasks
  if (state.tasks.length > 1) {
    bindings.push({ key: '^j/^k', label: 'reorder' });
  }

  // Flagged-task actions
  if (hasFlagged) {
    bindings.push({ key: 'R', label: `regen ${state.flaggedIds.size} flagged` });
  }

  // Packet preview toggle
  bindings.push({ key: 'p', label: state.isPacketPreviewOpen ? 'close preview' : 'preview' });

  // Save/discard
  if (state.dirty) {
    bindings.push({ key: 'Y', label: 'save' });
  } else {
    bindings.push({ key: 'Y', label: 'approve' });
  }
  bindings.push({ key: 'q', label: 'discard' });
  bindings.push({ key: '?', label: 'help' });

  return bindings;
}

export function PlanEditorFooter({ isPacketPreviewOpen, isNarrow }: { isPacketPreviewOpen: boolean; isNarrow: boolean }) {
  const t = useTheme();
  const tasks = planEditorStore.use(s => s.tasks);
  const cursor = planEditorStore.use(s => s.cursor);
  const dirty = planEditorStore.use(s => s.dirty);
  const flaggedIds = planEditorStore.use(s => s.flaggedIds);
  const expandedIds = planEditorStore.use(s => s.expandedIds);

  const bindings = getContextualBindings({
    tasks,
    cursor,
    dirty,
    flaggedIds,
    expandedIds,
    isPacketPreviewOpen,
  });

  // In narrow terminals, use abbreviated labels to fit
  const formatBinding = (b: FooterBinding): string =>
    isNarrow ? `${b.key} ${b.label.slice(0, 3)}` : `${b.key} ${b.label}`;

  // Split bindings across two lines for readability
  const midpoint = Math.ceil(bindings.length / 2);
  const line1 = bindings.slice(0, midpoint);
  const line2 = bindings.slice(midpoint);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim} wrap="truncate">
        {line1.map(formatBinding).join(' · ')}
      </Text>
      {line2.length > 0 && (
        <Text color={t.textDim} wrap="truncate">
          {line2.map(formatBinding).join(' · ')}
        </Text>
      )}
    </Box>
  );
}

// Exported for testing
export { getContextualBindings };
export type { FooterBinding };
```

### Integration in Plan Editor

In `src/features/workflow/components/plan-editor.tsx`, replace the inline footer rendering at the bottom of `PlanEditorComponent`:

Remove:

```tsx
{isNarrow ? (
  <>
    <Text color={t.textDim} wrap="truncate">{isCollapsedPacketPreview ? 'packet preview collapsed · j/k nav · p preview' : 'j/k nav · p preview · d del · m merge'}</Text>
    <Text color={t.textDim} wrap="truncate">{'e edit · s split · ^j/^k move · Y save · q quit · ?'}</Text>
  </>
) : (
  <>
    <Text color={t.textDim} wrap="truncate">
      {isCollapsedPacketPreview
        ? 'packet preview collapsed · j/k navigate · p packet preview'
        : 'j/k navigate · p packet preview · d delete · m merge · e edit · s split'}
    </Text>
    <Text color={t.textDim} wrap="truncate">{'<c-j>/<c-k> reorder · Y save · q discard · ? help'}</Text>
  </>
)}
```

Replace with:

```tsx
import { PlanEditorFooter } from './plan-editor-footer.js';

// At the footer position (isNarrow is already computed in PlanEditorComponent as `(width ?? 80) < 70`):
<PlanEditorFooter isPacketPreviewOpen={isPacketPreviewOpen} isNarrow={isNarrow} />
```

## Required Behavior

1. The footer shows only keybindings relevant to the current state.
2. When no tasks exist, navigation and task-action keys are hidden.
3. When flagged tasks exist, the `R regen N flagged` binding appears with the count.
4. The `m merge` binding only appears when cursor > 0 (merge requires a previous task).
5. The `^j/^k reorder` binding only appears when there are multiple tasks.
6. When dirty, the save binding says "save"; when clean, it says "approve".
7. The footer updates reactively as the user navigates, flags, or edits.
8. The footer fits in two lines using the `·` separator format.

## Non-Goals

- No help overlay changes (the `?` key still opens the full help overlay).
- No input bar or main workflow footer changes.
- No streaming or heartbeat changes.
- No new keybindings (only display logic changes; keybindings from brief 03 are assumed present).

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- The footer component reads directly from `planEditorStore` — no prop drilling of store state.
- `isPacketPreviewOpen` and `isNarrow` are props because they live in component-local state, not the store. `isNarrow` is `(width ?? 80) < 70` (already computed in `PlanEditorComponent`).
- `getContextualBindings` is a pure function exported for unit testing.
- Tests should verify: empty tasks hides navigation, flaggedIds > 0 shows R binding with count, cursor at 0 hides merge, dirty changes save label.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/features/workflow/components/plan-editor-footer.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files changed
- contextual bindings logic
- state conditions for each binding group
- integration point in plan-editor.tsx
- validation commands run and results
- risks or follow-ups
