# 01 - Hero Savings Banner

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a prominent hero savings banner to the summary screen that immediately shows the user how much they saved. This is visual elevation of existing `CostBreakdown` data, not a new calculation pipeline.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/cost-breakdown.tsx`
- `src/core/schemas/summary.ts` (CostBreakdown type)
- `src/core/formatting.ts` (formatCost)
- `src/components/theme.ts`
- `src/components/labeled-row.tsx`

## Write Ownership

Primary files:

```text
src/features/summary/components/hero-savings.tsx       (new)
src/features/summary/components/hero-savings.test.tsx  (new)
src/features/summary/screen.tsx                        (edit)
```

Do not edit engine files. Do not edit pricing logic. Do not create barrel files.

## Required Behavior

Create a `HeroSavings` component that renders a large, bold savings callout above the existing summary content. It receives the `CostBreakdown` from the summary and renders contextual messaging.

### Component: `src/features/summary/components/hero-savings.tsx`

```typescript
import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost } from '../../../core/formatting.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

interface HeroSavingsProps {
  costBreakdown: CostBreakdown | undefined;
}

export function HeroSavings({ costBreakdown }: HeroSavingsProps) {
  const t = useTheme();

  if (!costBreakdown) return null;
  if (costBreakdown.hasSavingsEstimate === false) return null;

  if (costBreakdown.savingsAmount <= 0) {
    return (
      <Box justifyContent="center" width="100%" marginTop={1}>
        <Text color={t.textDim}>No savings this run (split routing cost equal or higher)</Text>
      </Box>
    );
  }

  const actual = formatCost(costBreakdown.totalActualCost);
  const baseline = formatCost(costBreakdown.hypotheticalCost);
  const pct = Math.round(costBreakdown.savingsPercentage);

  return (
    <Box justifyContent="center" width="100%" marginTop={1} flexDirection="column" alignItems="center">
      <Text bold color={t.success}>
        {actual} actual vs {baseline} all-planner — {pct}% saved
      </Text>
      <Text color={t.textDim}>
        Saved {formatCost(costBreakdown.savingsAmount)} by routing {Math.round(costBreakdown.localCompletionRate * 100)}% of tasks to cheap implementer
      </Text>
    </Box>
  );
}
```

### Integration in `src/features/summary/screen.tsx`

Add the import at the top with the other summary component imports:

```typescript
import { HeroSavings } from './components/hero-savings.js';
```

Insert the `<HeroSavings>` component immediately after the "diptych complete" header and subtitle, before the `flexDirection="column"` detail box. Place it between the subtitle `<Box>` (line ~118-122) and the detail `<Box flexDirection="column" marginTop={1}>`:

```typescript
      <HeroSavings costBreakdown={summary.costBreakdown} />
```

### Degradation Rules

| Condition | Behavior |
|---|---|
| `costBreakdown` is undefined | Render nothing |
| `hasSavingsEstimate` is false | Render nothing |
| `savingsAmount <= 0` | Render dim "No savings this run" message |
| `savingsAmount > 0` | Render bold hero stat |

### Test: `src/features/summary/components/hero-savings.test.tsx`

```typescript
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { HeroSavings } from './hero-savings.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    hypotheticalCost: 0.95,
    actualPlannerCost: 0.03,
    actualImplementerCost: 0.09,
    totalActualCost: 0.12,
    savingsAmount: 0.83,
    savingsPercentage: 87,
    localCompletionRate: 0.92,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    hasSavingsEstimate: true,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isTotalActualCostKnown: true,
    isAllPlannerBaselineKnown: true,
    ...overrides,
  };
}

describe('HeroSavings', () => {
  it('renders hero stat when savings are available', () => {
    const { lastFrame } = render(<HeroSavings costBreakdown={makeCostBreakdown()} />);
    const output = lastFrame();
    expect(output).toContain('$0.12 actual vs $0.95 all-planner');
    expect(output).toContain('87% saved');
    expect(output).toContain('Saved $0.83');
  });

  it('renders nothing when costBreakdown is undefined', () => {
    const { lastFrame } = render(<HeroSavings costBreakdown={undefined} />);
    expect(lastFrame()).toBe('');
  });

  it('renders nothing when hasSavingsEstimate is false', () => {
    const breakdown = makeCostBreakdown({ hasSavingsEstimate: false });
    const { lastFrame } = render(<HeroSavings costBreakdown={breakdown} />);
    expect(lastFrame()).toBe('');
  });

  it('renders dim message when savingsAmount is zero', () => {
    const breakdown = makeCostBreakdown({ savingsAmount: 0, savingsPercentage: 0 });
    const { lastFrame } = render(<HeroSavings costBreakdown={breakdown} />);
    expect(lastFrame()).toContain('No savings this run');
  });

  it('renders dim message when savingsAmount is negative', () => {
    const breakdown = makeCostBreakdown({ savingsAmount: -0.05, savingsPercentage: -5 });
    const { lastFrame } = render(<HeroSavings costBreakdown={breakdown} />);
    expect(lastFrame()).toContain('No savings this run');
  });
});
```

## Non-Goals

- No new cost calculation logic.
- No changes to `CostBreakdown` schema or pricing engine.
- No persistence or stats accumulation.
- No cost gate or approval prompt.

## Validation Commands

```bash
npm test -- src/features/summary/components/hero-savings.test.tsx
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files created and edited
- hero banner rendering for priced, unpriced, zero-savings, and missing-breakdown cases
- validation commands run and results
- any skipped validation and why
- confirmation that no git add, git stage, git commit, or git stash was run
