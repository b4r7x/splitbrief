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

function accumulateSession(stats: Stats, input: StatsUpdateInput): Stats {
  const next: Stats = {
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
