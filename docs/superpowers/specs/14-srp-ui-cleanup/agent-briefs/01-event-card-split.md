# 01 — Split event-card.tsx within event-cards/ folder

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Split `src/features/workflow/components/event-cards/event-card.tsx` (535 LOC, 132 switch cases) into focused sibling components. The main switch stays as the router — but rendering logic for card groups moves to dedicated files.

## Required Skills

- `/clean-code`
- `/test-behavior-not-implementation`
- `/coding-standards`

## Required Reading

- `CLAUDE.md`
- `docs/STRUCTURE.md` — §Deep modules and folder colocation
- `src/features/workflow/components/event-cards/event-card.tsx` — full file
- `src/features/workflow/components/event-cards/card.tsx` — base Card component
- `src/features/workflow/components/event-cards/` — see all existing siblings

## Write Ownership

```
src/features/workflow/components/event-cards/event-card.tsx    (rewrite — router only)
src/features/workflow/components/event-cards/event-role.ts     (create — getGutterRole)
src/features/workflow/components/event-cards/simple-cards.tsx   (create — simple one-liner cards)
src/features/workflow/components/event-cards/task-cards.tsx     (create — task lifecycle cards)
src/features/workflow/components/event-cards/cost-cards.tsx     (create — cost/budget cards)
src/features/workflow/components/event-cards/recovery-cards.tsx (create — recovery/rewind cards)
```

## Required Behavior

### Part A: Create event-role.ts — gutter role mapping

Extract `getGutterRole()` (currently lines ~63-114) — this is a pure function mapping event types to visual roles. It has no React dependency.

```typescript
export type GutterRole = 'planner' | 'implementer' | null;

export function getGutterRole(eventType: string): GutterRole {
  // ... exhaustive switch from current implementation
}
```

### Part B: Create simple-cards.tsx — one-liner event cards

Extract rendering for simple events that return a single `<Card>` with a text value. These are the ~80 cases that look like:

```tsx
case 'warning': return <Card label="warning" value={event.message} color="warning" />;
case 'error': return <Card label="error" value={event.message} color="error" />;
```

Create a function:
```tsx
export function renderSimpleCard(event: EngineEvent): ReactNode | undefined {
  switch (event.type) {
    case 'warning': return <Card label="warning" value={event.message} color="warning" />;
    case 'error': return <Card label="error" value={event.message} color="error" />;
    // ... all simple one-liner cases
    default: return undefined; // not a simple card
  }
}
```

### Part C: Create task-cards.tsx — task lifecycle events

Extract task-specific card rendering:
- `task_started` with `formatTaskStartedValue()`
- `task_completed`, `task_failed`, `task_skipped`
- `task_retry`, `task_reset`
- Helper: `formatTaskStartedValue()` (currently lines ~44-61)

```tsx
export function renderTaskCard(event: EngineEvent): ReactNode | undefined {
  switch (event.type) {
    case 'task_started': return <Card label="task" value={formatTaskStartedValue(event)} />;
    // ... task lifecycle cases
    default: return undefined;
  }
}
```

### Part D: Create cost-cards.tsx — cost and budget events

Extract cost-related rendering:
- `cost_prediction`, `cost_update`
- `budget_warning`, `budget_paused`, `budget_exceeded`
- `cost_gate_*` events

### Part E: Create recovery-cards.tsx — recovery and rewind events

Extract recovery flow rendering:
- `recovery_prompted`, `recovery_action_*`
- `rewind_*`, `task_reset`
- `user_edit_*`

### Part F: Rewrite event-card.tsx as routing shell

After extraction, `event-card.tsx` becomes a thin router:

```tsx
import { renderSimpleCard } from './simple-cards.js';
import { renderTaskCard } from './task-cards.js';
import { renderCostCard } from './cost-cards.js';
import { renderRecoveryCard } from './recovery-cards.js';
import { getGutterRole } from './event-role.js';

export function EventCard({ event, diffExpanded }: EventCardProps): ReactNode {
  const theme = useTheme();

  // Try each category — first match wins
  const content =
    renderSimpleCard(event) ??
    renderTaskCard(event) ??
    renderCostCard(event) ??
    renderRecoveryCard(event) ??
    renderComplexCard(event, diffExpanded); // ImplementerCard, ValidateCard etc. stay inline

  if (!content) return null;

  const role = getGutterRole(event.type);
  // ... gutter rendering (stays here, ~20 lines)
}
```

The complex card delegations (ImplementerCard, ValidateCard, EscalateCard, PlannerStatusCard, etc.) stay as direct `<Component>` references in event-card.tsx — they're already separate components. Only inline JSX is extracted.

### Important: Keep existing sub-components untouched

Do NOT modify or move: `card.tsx`, `implementer-card.tsx`, `validate-card.tsx`, `escalate-card.tsx`, `planner-status-card.tsx`, `cost-prediction-card.tsx`, `user-message-card.tsx`, `streaming-lines.tsx`, `workflow-config-card.tsx`.

Final structure:
```
event-cards/
├── event-card.tsx        (~100 LOC — router + gutter)
├── event-role.ts         (~60 LOC — pure role mapping)
├── simple-cards.tsx      (~120 LOC — one-liner events)
├── task-cards.tsx        (~60 LOC — task lifecycle)
├── cost-cards.tsx        (~40 LOC — cost/budget)
├── recovery-cards.tsx    (~50 LOC — recovery/rewind)
├── card.tsx              (existing — unchanged)
├── implementer-card.tsx  (existing — unchanged)
├── validate-card.tsx     (existing — unchanged)
├── escalate-card.tsx     (existing — unchanged)
├── ... other existing    (unchanged)
```

## Tests

- `event-role.test.ts` — test `getGutterRole` for representative event types
- If `event-card.test.ts` exists, keep it — it tests the router which still works

## Verification

- [ ] `event-card.tsx` is ≤120 LOC
- [ ] All 132 event types still render (no cases lost in extraction)
- [ ] Existing sub-components untouched
- [ ] `npm run test-ci` passes
