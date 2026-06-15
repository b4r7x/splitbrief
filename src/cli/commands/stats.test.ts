import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readStats, updateStats } from '../../core/stats/persistence.js';
import { saveSummary } from '../../core/sessions/io.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import type { Session } from '../../core/schemas/session.js';
import { registerStatsCommand } from './stats.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('stats-command-test');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDir(projectDir);
});

async function runStats(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatsCommand(program);
  await program.parseAsync(['node', 'diptych', 'stats', ...args]);
}

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return lines;
}

function makeBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    hypotheticalCost: 1,
    actualPlannerCost: 0.05,
    actualImplementerCost: 0.2,
    totalActualCost: 0.25,
    savingsAmount: 0.75,
    savingsPercentage: 75,
    localCompletionRate: 2 / 3,
    hasSavingsEstimate: true,
    ...overrides,
  };
}

function completeSession(id: string, breakdown: CostBreakdown): Session {
  return {
    id,
    feature: 'demo',
    startedAt: 1,
    completedAt: 2,
    stateVersion: 1,
    status: 'complete',
    summary: {
      feature: 'demo',
      totalTasks: 3,
      completedByLocal: 2,
      escalatedToPlanner: 1,
      skipped: 0,
      failed: 0,
      totalTime: 10,
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
      estimatedCostSavings: '$0.75',
      escalationRate: 1 / 3,
      costBreakdown: breakdown,
    },
  };
}

describe('stats command', () => {
  it('emits machine-readable stats with --json', async () => {
    updateStats(projectDir, {
      costBreakdown: {
        totalActualCost: 0.25,
        hypotheticalCost: 1,
        actualPlannerCost: 0.05,
        actualImplementerCost: 0.2,
        savingsAmount: 0.8,
        savingsPercentage: 76,
        localCompletionRate: 2 / 3,
        providerCosts: { anthropic: { inputTokens: 10, outputTokens: 20, cost: 0.25 } },
      },
      totalTasks: 3,
      completedByLocal: 2,
      escalatedToPlanner: 1,
      providerCosts: { anthropic: { cost: 0.25 } },
    });
    const chunks = captureStdout();

    await runStats(['--project', projectDir, '--json']);

    const output = JSON.parse(chunks.join('')) as {
      type?: string;
      stats?: { totalSessions?: number; totalTasks?: number };
    };
    expect(output.type).toBe('stats');
    expect(output.stats?.totalSessions).toBe(1);
    expect(output.stats?.totalTasks).toBe(3);
  });

  it('emits empty stats as JSON when no sessions have completed', async () => {
    const chunks = captureStdout();

    await runStats(['--project', projectDir, '--json']);

    const output = JSON.parse(chunks.join('')) as {
      type?: string;
      stats?: { totalSessions?: number };
    };
    expect(output).toMatchObject({ type: 'stats', stats: { totalSessions: 0 } });
  });

  it('--json totalHypotheticalCost equals the sum of per-session hypotheticalCost', async () => {
    const a = makeBreakdown({ hypotheticalCost: 1, savingsAmount: 0.75 });
    const b = makeBreakdown({ hypotheticalCost: 2, savingsAmount: 1.4 });
    updateStats(projectDir, {
      costBreakdown: a,
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });
    updateStats(projectDir, {
      costBreakdown: b,
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });
    const chunks = captureStdout();

    await runStats(['--project', projectDir, '--json']);

    const output = JSON.parse(chunks.join('')) as {
      stats?: { totalHypotheticalCost?: number; averageSavingsPercentage?: number };
    };
    expect(output.stats?.totalHypotheticalCost).toBeCloseTo(
      a.hypotheticalCost + b.hypotheticalCost,
    );
    const expectedRate =
      ((a.savingsAmount + b.savingsAmount) / (a.hypotheticalCost + b.hypotheticalCost)) * 100;
    expect(output.stats?.averageSavingsPercentage).toBeCloseTo(expectedRate);
  });

  it("human output prints the 'All-planner would be:' baseline equal to totalHypotheticalCost", async () => {
    updateStats(projectDir, {
      costBreakdown: makeBreakdown({ hypotheticalCost: 3.5 }),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });
    const lines = captureConsoleLog();

    await runStats(['--project', projectDir]);

    const baseline = lines.find((line) => line.includes('All-planner would be:'));
    expect(baseline).toBeDefined();
    expect(baseline).toContain('$3.50');
  });

  it('--rebuild heals a double-counted stats.json from session history', async () => {
    const breakdown = makeBreakdown({ hypotheticalCost: 1, savingsAmount: 0.75 });
    saveSummary({ projectDir, sessionId: 'sess-1' }, completeSession('sess-1', breakdown));

    mkdirSync(join(projectDir, '.diptych'), { recursive: true });
    writeFileSync(
      join(projectDir, '.diptych', 'stats.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        totalSessions: 1,
        totalCost: 0.25,
        totalSavings: 0.75,
        totalHypotheticalCost: breakdown.hypotheticalCost + breakdown.actualPlannerCost,
        averageSavingsPercentage: 71,
        totalTasks: 3,
        totalLocalTasks: 2,
        totalEscalatedTasks: 1,
        providerTotals: {},
      }),
    );
    captureStdout();

    await runStats(['--project', projectDir, '--rebuild', '--json']);

    const healed = readStats(projectDir);
    expect(healed.totalSessions).toBe(1);
    expect(healed.totalHypotheticalCost).toBeCloseTo(breakdown.hypotheticalCost);
    expect(healed.averageSavingsPercentage).toBeCloseTo(
      (breakdown.savingsAmount / breakdown.hypotheticalCost) * 100,
    );
  });
});
