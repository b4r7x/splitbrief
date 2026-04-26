# 03 — Status Line Component

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

You are adding an always-visible cost status line to the TUI. It appears on every active screen and updates live as the cost store changes.

## Intent

Give users a persistent, compact cost summary without forcing them to open any overlay. The line must fit in one terminal row, degrade gracefully at narrow widths, and render stable fallbacks when data is unavailable.

## Scope

### In scope

- Create `src/features/workflow/components/cost-status-line.tsx` (or equivalent — see ADR-009).
- Mount it in the workflow screen layout at the top, below the header.
- Subscribe exclusively to `tokensStore` and `configStore` — no direct event handling in the component.
- Render: `[mode] · spent $X.YY · proj $Y.YY · budget $Z · NN% plan · cache NN%`.
- Render stable fallbacks: `proj n/a` when `completedTaskCount === 0` and no prediction; `budget n/a` when `maxBudget` is not configured; `cache n/a` when cache token data is absent.
- Unit test the pure format helpers.

### Out of scope

- Modifying `CostFooter` (the bottom bar) — do not touch `cost-footer.tsx`.
- Adding keybinding logic (brief 04 does that).
- Any engine changes.
- Any overlay or drill-down (brief 04).

## Code Context

### Files to read first

- `CLAUDE.md` — project conventions (no useMemo, no forwardRef, zero barrels).
- `docs/STORES.md` — how to use `useSyncExternalStore` via store `.use()`.
- `docs/HOOKS.md` — hook authoring rules.
- `src/features/workflow/screen.tsx` — workflow screen layout; find where `CostFooter` is mounted.
- `src/features/workflow/layout.ts` — layout constants (columns, rows).
- `src/features/workflow/components/cost-footer.tsx` — existing bottom bar; do not duplicate its output logic; read `use-cost-stats.ts` it uses.
- `src/features/workflow/hooks/use-cost-stats.ts` — `useCostStats`, `formatCostDisplay`, `CostStats` interface.
- `src/stores/workflow/tokens.ts` — `tokensStore`, `TokensState` with new fields from brief 01.
- `src/stores/project/config.ts` — `configStore`, how to read `config.workflow.maxBudget` and `config.workflow.mode`.
- `src/components/theme.ts` — `useTheme` color tokens.
- `src/core/formatting.ts` — `formatCost`.

### Files to touch

- `src/features/workflow/components/cost-status-line.tsx` (new file)
- `src/features/workflow/components/cost-status-line.test.ts` (new file)
- `src/features/workflow/screen.tsx` (mount the component)

**Collision check — before touching `screen.tsx`:** read `docs/superpowers/specs/2026-04-22-smart-intake-brief-review-ux/agent-briefs/03-cost-risk-ux.md` to verify it does not claim `screen.tsx`. If it does, coordinate; otherwise proceed.

Do not touch `cost-footer.tsx`, `layout.ts`, or any store file.

## Implementation Plan

### Step 1 — Create pure format helpers in cost-status-line.tsx

Write and export these pure functions (no React, no hooks):

```ts
export function formatSpent(cost: number): string
// '$1.23' — always show two decimal places

export function formatProjected(
  completedCount: number,
  totalActualCost: number,
  prediction: CostPrediction | null,
  totalTasks: number,
): string
// Rolling avg when completedCount > 0: '$X.YY'
// Fall back to prediction.expectedCost when completedCount === 0
// 'proj n/a' when neither is available

export function formatBudget(maxBudget: number | undefined): string
// '$X.YY' when defined, '' (empty — omit column) when undefined

export function formatPlanPct(plannerInput: number, totalInput: number): number
// percentage of total input tokens spent on planning (0–100)

export function formatCachePct(cacheRead: number | undefined, input: number): string
// 'NN%' when cacheRead is defined and >0, 'cache n/a' when undefined or both zero
// Aggregate inputs: sum all perPhase[phase].cacheReadTokens for cacheRead;
// use tokenUsage.plannerInput + tokenUsage.implementerInput for input.
// This derivation happens in the caller (CostStatusLine component), not inside this function.

export function buildStatusLine(parts: string[]): string
// joins non-empty parts with ' · '
```

### Step 2 — Create the CostStatusLine React component

```tsx
export function CostStatusLine() {
  const t = useTheme();
  const tokens = tokensStore.use(s => s);
  const config = configStore.use(s => s.config);
  const mode = config?.workflow?.mode;
  const maxBudget = config?.workflow?.maxBudget;

  // Aggregate cache read tokens across all phases for the session-wide cache % display.
  // This is the correct aggregation point: perPhase holds per-phase cache data;
  // the status line shows a session-wide summary.
  const totalCacheRead = Object.values(tokens.perPhase).reduce((sum, p) => sum + p.cacheReadTokens, 0);
  const totalInput = (tokens.tokenUsage?.plannerInput ?? 0) + (tokens.tokenUsage?.implementerInput ?? 0);

  // derive values using pure helpers from Step 1
  const spentText = formatSpent(costBreakdown?.totalActualCost ?? 0);
  const projText = formatProjected(tokens.completedTaskCount, costBreakdown?.totalActualCost ?? 0, tokens.prediction, totalTasks);
  const budgetText = formatBudget(maxBudget);
  const planPct = totalInput > 0 ? formatPlanPct(tokens.tokenUsage?.plannerInput ?? 0, totalInput) : null;
  const cacheText = formatCachePct(totalCacheRead > 0 ? totalCacheRead : undefined, totalInput);

  // NOTE: costBreakdown and totalTasks come from use-cost-stats.ts.
  // Read the existing useCostStats hook before writing this component; you may extend it
  // or call calculateCostBreakdown directly with data from tokensStore and configStore.

  const line = buildStatusLine([
    mode ? `mode: ${mode}` : '',
    spentText ? `spent ${spentText}` : '',
    projText,
    budgetText ? `budget ${budgetText}` : '',
    planPct !== null ? `${planPct}% plan` : '',
    cacheText,
  ]);

  return (
    <Box width="100%" paddingX={1}>
      <Text color={t.textDim}>{line}</Text>
    </Box>
  );
}
```

No `useMemo`. No `useCallback`. No `React.memo`. Read all needed values directly from store selectors.

Width handling: `buildStatusLine` receives an ordered list of segments. If the terminal is narrow (< 60 columns), omit lower-priority segments (cache %, budget) first. Read terminal width via `process.stdout.columns` (check how other components handle narrow layouts in `cost-footer.tsx`).

### Step 3 — Mount in workflow screen

In `src/features/workflow/screen.tsx`, find the `Box` or layout root that wraps the header area. Add `<CostStatusLine />` immediately below the header, above the event feed. The component is always rendered when the workflow screen is active.

Read `screen.tsx` carefully to understand its layout structure before modifying it. Make a minimal, surgical addition.

### Step 4 — Write tests in cost-status-line.test.ts

Test the pure format helpers:

- `formatProjected` returns rolling avg after tasks complete.
- `formatProjected` falls back to prediction when no tasks have completed.
- `formatProjected` returns `'proj n/a'` when neither is available.
- `formatBudget` returns empty string when `maxBudget` is undefined.
- `formatCachePct` returns `'cache n/a'` when cache token data is absent.
- `formatCachePct` returns correct percentage with data.
- `buildStatusLine` joins non-empty parts and skips empty ones.

Do not test React rendering in this brief — that is acceptable to omit for a pure layout component; test the logic only.

## Validation

- `npm test -- src/features/workflow/components/cost-status-line.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- Manually verify in dev: `npm run dev -- start "test feature"` — status line appears above event feed.

## Constraints

- No classes.
- No barrels.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- Must not import from `src/engine/**` directly — read from stores only.
- Must not duplicate the bottom `CostFooter` — the status line supplements it with projection and cache data, not replaces it.
- `cache n/a` (not `0%`) when cache token data is absent from `tokensStore`.
- If `workflow.maxBudget` is absent, the budget column is omitted entirely from the status line (no `budget n/a` — just skip).

## Escalation

If mounting in `screen.tsx` conflicts with changes from the smart-intake spec's brief 03, place the component in the layout as a comment stub and flag the conflict in a `// TODO: coordinate with smart-intake 03` comment. Do not force a merge conflict.

## Evidence Requirements

- `npm test -- src/features/workflow/components/cost-status-line.test.ts` passes.
- `npm run typecheck` passes with no errors.
- `npm run lint` passes.
- The status line is visible on the workflow screen during a real or mocked run.
