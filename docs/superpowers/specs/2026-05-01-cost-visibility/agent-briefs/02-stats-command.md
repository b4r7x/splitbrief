# 02 - Stats CLI Command

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a `diptych stats` CLI command that shows cumulative cost savings across all sessions, reading from a persisted `.diptych/stats.json` cache file. Write to this file on every `workflow_complete` event.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Engine code must not import React, Ink, features, components, or hooks.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/core/sessions/analytics.ts`
- `src/cli/commands/status.ts` (printCostHistory pattern)
- `src/core/schemas/summary.ts` (CostBreakdown)
- `src/core/formatting.ts` (formatCost)
- `src/core/paths.ts` (getDiptychPath)
- `src/engine/events/types.ts` (workflow_complete event)
- `src/cli/commands/start.ts` (command registration pattern)

## Write Ownership

Primary files:

```text
src/core/schemas/stats.ts          (new - Zod schema)
src/core/stats/persistence.ts      (new - read/write logic)
src/core/stats/persistence.test.ts (new - tests)
src/cli/commands/stats.ts          (new - CLI command)
src/cli/commands/stats.test.ts     (new - CLI tests)
```

Edit files:

```text
src/engine/orchestrator/events.ts  (edit - write stats on workflow_complete)
src/cli/program.ts                 (edit - register stats command)
```

Do not edit React/Ink components. Do not edit pricing calculation logic.

## Schema: `src/core/schemas/stats.ts`

```typescript
import { z } from 'zod';

export const StatsSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  totalSessions: z.number().int().nonnegative(),
  totalCost: z.number().nonnegative(),
  totalSavings: z.number().nonnegative(),
  totalHypotheticalCost: z.number().nonnegative(),
  averageSavingsPercentage: z.number().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  totalLocalTasks: z.number().int().nonnegative(),
  totalEscalatedTasks: z.number().int().nonnegative(),
  providerTotals: z.record(z.string(), z.object({
    cost: z.number().nonnegative(),
    sessions: z.number().int().nonnegative(),
  })),
});

export type Stats = z.infer<typeof StatsSchema>;

export function emptyStats(): Stats {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalSessions: 0,
    totalCost: 0,
    totalSavings: 0,
    totalHypotheticalCost: 0,
    averageSavingsPercentage: 0,
    totalTasks: 0,
    totalLocalTasks: 0,
    totalEscalatedTasks: 0,
    providerTotals: {},
  };
}
```

## Persistence: `src/core/stats/persistence.ts`

```typescript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDiptychPath } from '../paths.js';
import { StatsSchema, emptyStats, type Stats } from '../schemas/stats.js';
import { isENOENT } from '../../lib/process/errors.js';
import type { CostBreakdown } from '../schemas/summary.js';

const STATS_FILE = 'stats.json';

function statsPath(projectDir: string): string {
  return getDiptychPath(projectDir, STATS_FILE);
}

export function readStats(projectDir: string): Stats {
  try {
    const raw = readFileSync(statsPath(projectDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = StatsSchema.safeParse(parsed);
    if (!result.success) return emptyStats();
    return result.data;
  } catch (err) {
    if (isENOENT(err)) return emptyStats();
    return emptyStats();
  }
}

function writeStats(projectDir: string, stats: Stats): void {
  const filePath = statsPath(projectDir);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(stats, null, 2) + '\n', 'utf-8');
}

export interface StatsUpdateInput {
  costBreakdown: CostBreakdown;
  totalTasks: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  providerCosts?: Record<string, { cost: number }> | undefined;
}

export function updateStats(projectDir: string, input: StatsUpdateInput): void {
  const current = readStats(projectDir);
  const next: Stats = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalSessions: current.totalSessions + 1,
    totalCost: current.totalCost + input.costBreakdown.totalActualCost,
    totalSavings: current.totalSavings + input.costBreakdown.savingsAmount,
    totalHypotheticalCost: current.totalHypotheticalCost +
      input.costBreakdown.hypotheticalCost + input.costBreakdown.actualPlannerCost,
    averageSavingsPercentage: 0,
    totalTasks: current.totalTasks + input.totalTasks,
    totalLocalTasks: current.totalLocalTasks + input.completedByLocal,
    totalEscalatedTasks: current.totalEscalatedTasks + input.escalatedToPlanner,
    providerTotals: { ...current.providerTotals },
  };

  if (next.totalHypotheticalCost > 0) {
    next.averageSavingsPercentage = (next.totalSavings / next.totalHypotheticalCost) * 100;
  }

  if (input.providerCosts) {
    for (const [provider, pc] of Object.entries(input.providerCosts)) {
      const existing = next.providerTotals[provider];
      if (existing) {
        existing.cost += pc.cost;
        existing.sessions += 1;
      } else {
        next.providerTotals[provider] = { cost: pc.cost, sessions: 1 };
      }
    }
  }

  writeStats(projectDir, next);
}

export function rebuildStats(projectDir: string, sessions: StatsUpdateInput[]): void {
  let stats = emptyStats();
  for (const input of sessions) {
    stats = {
      version: 1,
      updatedAt: new Date().toISOString(),
      totalSessions: stats.totalSessions + 1,
      totalCost: stats.totalCost + input.costBreakdown.totalActualCost,
      totalSavings: stats.totalSavings + input.costBreakdown.savingsAmount,
      totalHypotheticalCost: stats.totalHypotheticalCost +
        input.costBreakdown.hypotheticalCost + input.costBreakdown.actualPlannerCost,
      averageSavingsPercentage: 0,
      totalTasks: stats.totalTasks + input.totalTasks,
      totalLocalTasks: stats.totalLocalTasks + input.completedByLocal,
      totalEscalatedTasks: stats.totalEscalatedTasks + input.escalatedToPlanner,
      providerTotals: { ...stats.providerTotals },
    };

    if (stats.totalHypotheticalCost > 0) {
      stats.averageSavingsPercentage = (stats.totalSavings / stats.totalHypotheticalCost) * 100;
    }

    if (input.providerCosts) {
      for (const [provider, pc] of Object.entries(input.providerCosts)) {
        const existing = stats.providerTotals[provider];
        if (existing) {
          existing.cost += pc.cost;
          existing.sessions += 1;
        } else {
          stats.providerTotals[provider] = { cost: pc.cost, sessions: 1 };
        }
      }
    }
  }
  writeStats(projectDir, stats);
}
```

## CLI Command: `src/cli/commands/stats.ts`

```typescript
import { Command } from 'commander';
import ansis from 'ansis';
import { resolveProjectDir } from '../setup.js';
import { readStats, rebuildStats } from '../../core/stats/persistence.js';
import { formatCost } from '../../core/formatting.js';
import { getProviderDisplayName } from '../../core/providers/catalog.js';
import { listSessions } from '../../core/sessions/io.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { cliError } from '../errors.js';
import type { StatsUpdateInput } from '../../core/stats/persistence.js';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show cumulative cost savings across all sessions')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .option('--rebuild', 'Rebuild stats from session history')
    .action((opts: { project?: string; rebuild?: boolean }) => {
      try {
        const projectDir = resolveProjectDir(opts.project);

        if (opts.rebuild) {
          const sessions = listSessions(projectDir);
          const inputs: StatsUpdateInput[] = [];
          for (const session of sessions) {
            if (session.status !== 'complete') continue;
            if (!session.summary?.costBreakdown) continue;
            inputs.push({
              costBreakdown: session.summary.costBreakdown,
              totalTasks: session.summary.totalTasks,
              completedByLocal: session.summary.completedByLocal,
              escalatedToPlanner: session.summary.escalatedToPlanner,
              providerCosts: session.summary.costBreakdown.providerCosts,
            });
          }
          rebuildStats(projectDir, inputs);
          console.log(`Rebuilt stats from ${inputs.length} session(s).`);
        }

        const stats = readStats(projectDir);

        if (stats.totalSessions === 0) {
          console.log('No completed sessions with cost data yet.');
          console.log(ansis.dim('Run a workflow to start tracking savings.'));
          return;
        }

        console.log(ansis.bold.green(`\n  diptych savings: ${formatCost(stats.totalSavings)} saved across ${stats.totalSessions} session${stats.totalSessions === 1 ? '' : 's'}\n`));
        console.log(`  ${ansis.dim('Total spent:')}          ${formatCost(stats.totalCost)}`);
        console.log(`  ${ansis.dim('All-planner would be:')} ${formatCost(stats.totalHypotheticalCost)}`);
        console.log(`  ${ansis.dim('Savings rate:')}         ${Math.round(stats.averageSavingsPercentage)}%`);
        console.log(`  ${ansis.dim('Tasks completed:')}      ${stats.totalTasks} (${stats.totalLocalTasks} local, ${stats.totalEscalatedTasks} escalated)`);

        const providers = Object.entries(stats.providerTotals);
        if (providers.length > 0) {
          console.log(`\n  ${ansis.bold('By Provider:')}`);
          for (const [id, data] of providers) {
            const name = getProviderDisplayName(id);
            console.log(`    ${ansis.dim(`${name}:`)}  ${formatCost(data.cost)} (${data.sessions} session${data.sessions === 1 ? '' : 's'})`);
          }
        }

        console.log(ansis.dim(`\n  Last updated: ${stats.updatedAt}`));
      } catch (err) {
        if (err instanceof Error && 'exitCode' in err) throw err;
        throw cliError(toErrorMessage(err), 1);
      }
    });
}
```

## Orchestrator Integration

In the file that handles `workflow_complete` events (look for where `saveSummary` is called or where the summary is finalized), add:

```typescript
import { updateStats } from '../../core/stats/persistence.js';

// After summary is computed and saved, within the workflow_complete handler:
if (summary.costBreakdown && summary.costBreakdown.hasSavingsEstimate !== false) {
  updateStats(projectDir, {
    costBreakdown: summary.costBreakdown,
    totalTasks: summary.totalTasks,
    completedByLocal: summary.completedByLocal,
    escalatedToPlanner: summary.escalatedToPlanner,
    providerCosts: summary.costBreakdown.providerCosts,
  });
}
```

Locate the exact integration point by searching for `workflow_complete` or `saveSummary` in `src/engine/orchestrator/`. The call must be in engine code (no React imports).

## Command Registration

In `src/cli/program.ts`, add alongside other command registrations:

```typescript
import { registerStatsCommand } from './commands/stats.js';

// In the registration block:
registerStatsCommand(program);
```

## Tests: `src/core/stats/persistence.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStats, updateStats, rebuildStats } from './persistence.js';
import type { CostBreakdown } from '../schemas/summary.js';

function makeTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'diptych-stats-'));
}

function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    hypotheticalCost: 0.95,
    actualPlannerCost: 0.05,
    actualImplementerCost: 0.07,
    totalActualCost: 0.12,
    savingsAmount: 0.88,
    savingsPercentage: 93,
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

describe('stats persistence', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('readStats returns empty stats when file does not exist', () => {
    const stats = readStats(testDir);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.version).toBe(1);
  });

  it('updateStats creates file and accumulates', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 5,
      completedByLocal: 4,
      escalatedToPlanner: 1,
      providerCosts: { anthropic: { cost: 0.12 } },
    });

    const stats = readStats(testDir);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalCost).toBeCloseTo(0.12);
    expect(stats.totalSavings).toBeCloseTo(0.88);
    expect(stats.totalTasks).toBe(5);
    expect(stats.totalLocalTasks).toBe(4);
    expect(stats.totalEscalatedTasks).toBe(1);
    expect(stats.providerTotals['anthropic']?.cost).toBeCloseTo(0.12);
  });

  it('updateStats accumulates across multiple calls', () => {
    const input = {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 3,
      completedByLocal: 2,
      escalatedToPlanner: 1,
      providerCosts: undefined,
    };

    updateStats(testDir, input);
    updateStats(testDir, input);

    const stats = readStats(testDir);
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalCost).toBeCloseTo(0.24);
    expect(stats.totalSavings).toBeCloseTo(1.76);
    expect(stats.totalTasks).toBe(6);
  });

  it('rebuildStats resets and rebuilds from inputs', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown({ totalActualCost: 99, savingsAmount: 99 }),
      totalTasks: 99,
      completedByLocal: 99,
      escalatedToPlanner: 0,
    });

    rebuildStats(testDir, [
      {
        costBreakdown: makeCostBreakdown(),
        totalTasks: 5,
        completedByLocal: 4,
        escalatedToPlanner: 1,
      },
    ]);

    const stats = readStats(testDir);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalCost).toBeCloseTo(0.12);
    expect(stats.totalTasks).toBe(5);
  });

  it('persisted file is valid JSON with version field', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const raw = readFileSync(join(testDir, '.diptych', 'stats.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
  });
});
```

## Non-Goals

- No TUI rendering or React components.
- No cost prediction or approval gate logic.
- No changes to existing `diptych status --history` behavior.
- No budget limits or cap enforcement.

## Validation Commands

```bash
npm test -- src/core/stats/persistence.test.ts
npm test -- src/cli/commands/stats.test.ts
npm run typecheck
npm run lint
```

## Expected Final Report

Report:

- files created and edited
- schema fields defined
- CLI output format
- orchestrator integration point (exact file and function)
- validation commands run and results
- any skipped validation and why
- confirmation that no git add, git stage, git commit, or git stash was run
