import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { updateStats } from '../../core/stats/persistence.js';
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

    const output = JSON.parse(chunks.join('')) as { type?: string; stats?: { totalSessions?: number; totalTasks?: number } };
    expect(output.type).toBe('stats');
    expect(output.stats?.totalSessions).toBe(1);
    expect(output.stats?.totalTasks).toBe(3);
  });

  it('emits empty stats as JSON when no sessions have completed', async () => {
    const chunks = captureStdout();

    await runStats(['--project', projectDir, '--json']);

    const output = JSON.parse(chunks.join('')) as { type?: string; stats?: { totalSessions?: number } };
    expect(output).toMatchObject({ type: 'stats', stats: { totalSessions: 0 } });
  });
});
