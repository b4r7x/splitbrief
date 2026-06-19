import { getDiptychPath } from '../paths.js';
import { StatsSchema, emptyStats, type Stats } from '../schemas/stats.js';
import { writeSecureFile, readValidatedJsonResult } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import { warnError } from '../../lib/warn.js';
import { error } from '../../utils/error.js';
import { nowIso } from '../../utils/format-time.js';
import type { CostBreakdown } from '../schemas/summary.js';
import { accumulateProviderCosts } from './provider-costs.js';

const STATS_FILE = 'stats.json';

function statsPath(projectDir: string): string {
  return getDiptychPath(projectDir, STATS_FILE);
}

const statsError = {
  lockTimeout: (lockPath: string) =>
    error('stats-lock-timeout', `timed out waiting for stats store lock: ${lockPath}`, {
      lockPath,
    }),
} as const;

function withStatsLock<T>(projectDir: string, fn: () => T): T {
  const lockPath = lockSibling(statsPath(projectDir));
  return withFileLock(lockPath, () => statsError.lockTimeout(lockPath), fn);
}

function parseStats(value: unknown): Stats | null {
  const r = StatsSchema.safeParse(value);
  return r.success ? r.data : null;
}

export function readStats(projectDir: string): Stats {
  const result = readValidatedJsonResult(statsPath(projectDir), parseStats);
  if (result.kind === 'value') return result.value;
  if (result.kind === 'unreadable') {
    warnError(
      `stats: unreadable ${STATS_FILE}; run 'diptych stats --rebuild' to heal it`,
      result.cause,
    );
  }
  return emptyStats();
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
  const sessionSavings =
    input.costBreakdown.hasSavingsEstimate === false
      ? 0
      : Math.max(0, input.costBreakdown.savingsAmount);
  const next: Stats = {
    version: 1,
    updatedAt: nowIso(),
    totalSessions: stats.totalSessions + 1,
    totalCost: stats.totalCost + input.costBreakdown.totalActualCost,
    totalSavings: stats.totalSavings + sessionSavings,
    totalHypotheticalCost:
      stats.totalHypotheticalCost +
      (input.costBreakdown.hasSavingsEstimate === false ? 0 : input.costBreakdown.hypotheticalCost),
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
  withStatsLock(projectDir, () => {
    const existing = readValidatedJsonResult(statsPath(projectDir), parseStats);
    if (existing.kind === 'unreadable') {
      warnError(
        `stats: skipping update; existing ${STATS_FILE} is unreadable and lifetime totals would be lost. Run 'diptych stats --rebuild' to heal it`,
        existing.cause,
      );
      return;
    }
    const current = existing.kind === 'value' ? existing.value : emptyStats();
    writeStats(projectDir, accumulateSession(current, input));
  });
}

export function rebuildStats(projectDir: string, sessions: StatsUpdateInput[]): void {
  withStatsLock(projectDir, () => {
    let stats = emptyStats();
    for (const input of sessions) {
      stats = accumulateSession(stats, input);
    }
    writeStats(projectDir, stats);
  });
}
