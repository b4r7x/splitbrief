# 04 — Cost Drill-Down Overlay

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

You are adding a cost drill-down overlay to the TUI. It opens on the `$` keybinding during the workflow screen and shows per-phase horizontal bars, input vs output token split, and cache-hit % per phase where available.

## Intent

Let users inspect where cost is accumulating without leaving the workflow. The overlay appears over the workflow screen, shows per-phase cost bars, and dismisses on any keypress.

## Scope

### In scope

- Add `'cost-drilldown'` to `OverlayType` in `src/stores/navigation/router.ts`.
- Create `src/features/workflow/components/cost-drilldown-overlay.tsx`.
- Wire the `$` keybinding in `src/features/workflow/hooks/use-workflow-keys.ts`.
- Dismiss the overlay on any subsequent keypress.
- Display per-phase horizontal bar chart (text-based), input vs output token split per phase, and cache-hit % per phase (or `n/a`).
- Display per-task horizontal bar chart showing total tokens per task. Note: the `task_tokens` event does not carry an input/output split, so per-task bars show total tokens only (not split). Document this limitation with `(total tokens)` in the row label.
- Test pure bar-formatting helpers.

### Out of scope

- Any engine changes.
- Modifying `CostFooter` or `CostStatusLine` (brief 03).
- Navigation between screens (this is an overlay, not a screen).
- `routerStore` screen transitions (the overlay does not modify `screen`).

## Code Context

### Files to read first

- `src/stores/navigation/router.ts` — `OverlayType`, how `overlayStore` (or equivalent) is managed. Note: the current `OverlayType` in `router.ts` may be managed via a separate `overlayStore` — read the file carefully; find where `OverlayType` state is stored and mutated.
- `src/features/workflow/hooks/use-workflow-keys.ts` — existing keybindings; find how overlays are opened today (e.g. `?` opens help). Mirror that pattern for `$`.
- `src/features/workflow/screen.tsx` — where overlays are rendered (find the `switch` or conditional on overlay type).
- `src/stores/workflow/tokens.ts` — `tokensStore`, `TokensState`, `perPhase` map from brief 01.
- `src/features/workflow/components/cost-footer.tsx` — for terminal-width handling patterns.
- `src/components/theme.ts` — `useTheme`.
- `src/core/formatting.ts` — `formatCost`.
- Existing overlay components (e.g. help overlay) — find one under `src/features/workflow/components/` that renders in overlay mode; use it as the layout template.

### Files to touch

- `src/stores/navigation/router.ts` — add `'cost-drilldown'` to `OverlayType`
- `src/features/workflow/hooks/use-workflow-keys.ts` — wire `$` key
- `src/features/workflow/screen.tsx` — render overlay when type is `'cost-drilldown'`
- `src/features/workflow/components/cost-drilldown-overlay.tsx` (new)
- `src/features/workflow/components/cost-drilldown-overlay.test.ts` (new)

Do not touch `cost-footer.tsx` or any engine files.

## Implementation Plan

### Step 1 — Extend OverlayType

In `src/stores/navigation/router.ts`, add `'cost-drilldown'` to the `OverlayType` union:

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
```

No other change to `router.ts`.

### Step 2 — Wire $ keybinding

In `use-workflow-keys.ts`, find where the `?` key opens the help overlay. Mirror the pattern:

```ts
// When overlay is 'none' and key is '$':
//   open 'cost-drilldown' overlay
// When overlay is 'cost-drilldown':
//   any key dismisses (sets overlay to 'none')
```

The `$` keybinding is only active when the workflow screen is visible and no other overlay is open. If another overlay is open, `$` is ignored (not a key conflict).

Read the existing keybinding approach carefully before writing code. Use whatever dispatch or setter the existing pattern uses for opening overlays.

### Step 3 — Create pure bar and format helpers in cost-drilldown-overlay.tsx

Write and export these pure functions:

```ts
export type PhaseRow = {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
};

export type TaskRow = {
  taskId: string;
  title: string;
  totalTokens: number;
};

export function buildPhaseRows(
  perPhase: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cost: number }>
): PhaseRow[]
// Sort by cost descending. Return sorted array.

export function buildTaskRows(
  perTask: Record<string, { totalTokens: number; cost: number; title: string }>
): TaskRow[]
// Sort by totalTokens descending. Return sorted array.
// Note: task_tokens event carries no input/output split — totalTokens is the only metric.

export function renderBar(value: number, max: number, width: number): string
// ASCII bar: '████░░░░' style using block chars or simple '=' chars.
// width is the available column count for the bar.
// Returns empty string if max === 0.

export function formatCacheHitPct(cacheRead: number, input: number): string
// 'NN%' when cacheRead > 0, 'cache n/a' when cacheRead === 0 or input === 0

export function formatInputOutputSplit(inputTokens: number, outputTokens: number): string
// 'in: NNN k / out: NNN k'
// Scale to k (thousands) when total > 1000

export function formatTotalTokens(totalTokens: number): string
// 'NNN k tokens (total)' — label includes '(total)' to signal no split is available
```

### Step 4 — Create the CostDrilldownOverlay component

The overlay renders a full-screen or fixed-height `Box` above the workflow content. Study an existing overlay (e.g. help overlay) for the `Box` structure. The overlay has two sections: per-phase and per-task.

```tsx
export function CostDrilldownOverlay() {
  const t = useTheme();
  const { perPhase, perTask } = tokensStore.use(s => ({ perPhase: s.perPhase, perTask: s.perTask }));
  const phaseRows = buildPhaseRows(perPhase);
  const taskRows = buildTaskRows(perTask);
  const maxCost = phaseRows[0]?.cost ?? 0;
  const maxTaskTokens = taskRows[0]?.totalTokens ?? 0;
  const termWidth = process.stdout.columns ?? 80;
  const barWidth = Math.max(10, Math.min(30, termWidth - 40));

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>Cost Breakdown  (press any key to dismiss)</Text>
      <Box height={1} />

      <Text color={t.textDim}>— by phase —</Text>
      {phaseRows.map(row => (
        <Box key={row.phase} flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <Text color={t.text}>{row.phase.padEnd(18)}</Text>
            <Text color={t.accent}>{renderBar(row.cost, maxCost, barWidth)}</Text>
            <Text color={t.textDim}>{formatCost(row.cost)}</Text>
          </Box>
          <Box marginLeft={2} gap={2}>
            <Text color={t.textDim}>{formatInputOutputSplit(row.inputTokens, row.outputTokens)}</Text>
            <Text color={t.textDim}>{formatCacheHitPct(row.cacheReadTokens, row.inputTokens)}</Text>
          </Box>
        </Box>
      ))}
      {phaseRows.length === 0 && <Text color={t.textDim}>No phase data yet.</Text>}

      <Box height={1} />
      <Text color={t.textDim}>— by task —</Text>
      {taskRows.map(row => (
        <Box key={row.taskId} gap={1}>
          <Text color={t.text}>{row.title.slice(0, 20).padEnd(20)}</Text>
          <Text color={t.accent}>{renderBar(row.totalTokens, maxTaskTokens, barWidth)}</Text>
          <Text color={t.textDim}>{formatTotalTokens(row.totalTokens)}</Text>
        </Box>
      ))}
      {taskRows.length === 0 && <Text color={t.textDim}>No task data yet.</Text>}
    </Box>
  );
}
```

No `useMemo`. No `React.memo`. Derive all display values inline or via the pure helpers.

### Step 5 — Mount in workflow screen

In `screen.tsx`, find where other overlays are rendered (the conditional block for overlay type). Add:

```tsx
{overlay === 'cost-drilldown' && <CostDrilldownOverlay />}
```

Follow the exact same mounting pattern as the help overlay.

### Step 6 — Write tests

Test pure helpers in `cost-drilldown-overlay.test.ts`:

- `buildPhaseRows` sorts by cost descending.
- `buildPhaseRows` returns empty array for empty `perPhase`.
- `buildTaskRows` sorts by totalTokens descending.
- `buildTaskRows` returns empty array for empty `perTask`.
- `renderBar` returns correct proportional bar.
- `renderBar` returns empty string when `max === 0`.
- `formatCacheHitPct` returns `'cache n/a'` when `cacheRead === 0`.
- `formatCacheHitPct` returns correct percentage.
- `formatInputOutputSplit` scales to k when appropriate.
- `formatTotalTokens` includes `(total)` suffix to indicate no split available.

## Validation

- `npm test -- src/features/workflow/components/cost-drilldown-overlay.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- Manual: pressing `$` during a workflow session opens the overlay; any key dismisses it.

## Constraints

- No classes.
- No barrels.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- The `$` key must not interfere with text input fields. Only activate when the workflow is in `'normal'` input mode (check `useInputMode` or equivalent).
- The overlay is not persisted; dismissing it is stateless.
- Do not add a `'cost-drilldown'` screen to the router — overlay only, as per ADR-008.
- Engine must not be imported from the component.

## Escalation

If the existing overlay mounting pattern in `screen.tsx` is incompatible with a new overlay type (e.g. a `switch` with no `default`), add the new case and ensure the `switch` exhaustiveness check (if any) is updated. If the overlay pattern uses a separate overlay store from `routerStore`, extend that store instead of `routerStore.OverlayType`.

## Evidence Requirements

- `npm test -- src/features/workflow/components/cost-drilldown-overlay.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- The `$` key opens the overlay during workflow; any key dismisses it.
- `'cost-drilldown'` appears in `OverlayType` and TypeScript narrows it correctly.
