import { getDiptychPath } from '../paths.js';
import { StatsSchema, emptyStats, type Stats } from '../schemas/stats.js';
import { writeSecureFile, readValidatedJson } from '../../lib/fs.js';
import type { CostBreakdown } from '../schemas/summary.js';
import { accumulateProviderCosts } from './provider-costs.js';

const STATS_FILE = 'stats.json';

function statsPath(projectDir: string): string {
  return getDiptychPath(projectDir, STATS_FILE);
}

export function readStats(projectDir: string): Stats {
  return readValidatedJson(
    statsPath(projectDir),
    (v) => {
      const r = StatsSchema.safeParse(v);
      return r.success ? r.data : null;
    },
    emptyStats(),
    'stats: unreadable file',
  );
}

function writeStats(projectDir: string, stats: Stats): void {
  const filePath = statsPath(projectDir);
  writeSecureFile(filePath, JSON.stringify(stats, null, 2) + '\n');
}

export interface StatsUpdateInput {
  costBreakdown: CostBreakdown;
  totalTasks: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  providerCosts?: Record<string, { cost: number }> | undefined;
}

function accumulateSession(stats: Stats, input: StatsUpdateInput): Stats {
  const next: Stats = {
    version: 1,
    updatedAt: new Date().toISOString(),
    totalSessions: stats.totalSessions + 1,
    totalCost: stats.totalCost + input.costBreakdown.totalActualCost,
    totalSavings: stats.totalSavings + input.costBreakdown.savingsAmount,
    totalHypotheticalCost:
      stats.totalHypotheticalCost +
      input.costBreakdown.hypotheticalCost +
      input.costBreakdown.actualPlannerCost,
    averageSavingsPercentage: 0,
    totalTasks: stats.totalTasks + input.totalTasks,
    totalLocalTasks: stats.totalLocalTasks + input.completedByLocal,
    totalEscalatedTasks: stats.totalEscalatedTasks + input.escalatedToPlanner,
    providerTotals: { ...stats.providerTotals },
  };

  if (next.totalHypotheticalCost > 0) {
    next.averageSavingsPercentage = (next.totalSavings / next.totalHypotheticalCost) * 100;
  }

  if (input.providerCosts) {
    accumulateProviderCosts(next.providerTotals, input.providerCosts);
  }

  return next;
}

export function updateStats(projectDir: string, input: StatsUpdateInput): void {
  const current = readStats(projectDir);
  writeStats(projectDir, accumulateSession(current, input));
}

export function rebuildStats(projectDir: string, sessions: StatsUpdateInput[]): void {
  let stats = emptyStats();
  for (const input of sessions) {
    stats = accumulateSession(stats, input);
  }
  writeStats(projectDir, stats);
}
