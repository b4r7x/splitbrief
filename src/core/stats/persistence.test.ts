import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeCostBreakdown as makeSharedCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { readStats, updateStats, rebuildStats } from './persistence.js';
import type { CostBreakdown } from '../schemas/summary.js';

function makeTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'splitbrief-stats-'));
}

function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return makeSharedCostBreakdown({
    hypotheticalCost: 0.95,
    actualPlannerCost: 0.05,
    actualImplementerCost: 0.07,
    totalActualCost: 0.12,
    savingsAmount: 0.88,
    savingsPercentage: 93,
    localCompletionRate: 0.92,
    hasSavingsEstimate: true,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isTotalActualCostKnown: true,
    isAllPlannerBaselineKnown: true,
    ...overrides,
  });
}

describe('stats persistence', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('readStats returns empty stats when file does not exist (no warn)', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stats = readStats(testDir);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.version).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('readStats warns once and returns empty stats when the file is corrupt', () => {
    mkdirSync(join(testDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(testDir, '.splitbrief', 'stats.json'), '{ this is not json');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const stats = readStats(testDir);

    expect(stats.totalSessions).toBe(0);
    expect(stats.version).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('--rebuild');
    warn.mockRestore();
  });

  it('readStats warns and returns empty stats when the file fails schema validation', () => {
    mkdirSync(join(testDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(testDir, '.splitbrief', 'stats.json'), JSON.stringify({ version: 999 }));
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const stats = readStats(testDir);

    expect(stats.totalSessions).toBe(0);
    expect(stats.version).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('--rebuild');
    warn.mockRestore();
  });

  it('updateStats preserves an unreadable stats.json instead of overwriting lifetime totals', () => {
    const statsFile = join(testDir, '.splitbrief', 'stats.json');
    mkdirSync(join(testDir, '.splitbrief'), { recursive: true });
    const corrupt = '{ this is not json';
    writeFileSync(statsFile, corrupt);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 5,
      completedByLocal: 4,
      escalatedToPlanner: 1,
    });

    expect(readFileSync(statsFile, 'utf-8')).toBe(corrupt);
    const hint = warn.mock.calls.map((c) => String(c[0] ?? '')).join('');
    expect(hint).toContain('--rebuild');
    warn.mockRestore();
  });

  it('updateStats preserves a schema-invalid stats.json instead of resetting totals', () => {
    const statsFile = join(testDir, '.splitbrief', 'stats.json');
    mkdirSync(join(testDir, '.splitbrief'), { recursive: true });
    const stale = JSON.stringify({ version: 999, totalSessions: 42 });
    writeFileSync(statsFile, stale);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    expect(readFileSync(statsFile, 'utf-8')).toBe(stale);
    const hint = warn.mock.calls.map((c) => String(c[0] ?? '')).join('');
    expect(hint).toContain('--rebuild');
    warn.mockRestore();
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

  it('totalHypotheticalCost equals the sum of per-session hypotheticalCost (no planner double-count)', () => {
    const breakdownA = makeCostBreakdown({
      hypotheticalCost: 1.0,
      actualPlannerCost: 0.3,
      savingsAmount: 0.7,
    });
    const breakdownB = makeCostBreakdown({
      hypotheticalCost: 2.0,
      actualPlannerCost: 0.5,
      savingsAmount: 1.4,
    });

    updateStats(testDir, {
      costBreakdown: breakdownA,
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });
    updateStats(testDir, {
      costBreakdown: breakdownB,
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const stats = readStats(testDir);
    expect(stats.totalHypotheticalCost).toBeCloseTo(
      breakdownA.hypotheticalCost + breakdownB.hypotheticalCost,
    );
    const expectedRate =
      ((breakdownA.savingsAmount + breakdownB.savingsAmount) / stats.totalHypotheticalCost) * 100;
    expect(stats.averageSavingsPercentage).toBeCloseTo(expectedRate);
  });

  it('does not add negative savings to the positive savings aggregate', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown({
        hypotheticalCost: 0.1,
        totalActualCost: 0.15,
        savingsAmount: -0.05,
        savingsPercentage: -50,
      }),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const stats = readStats(testDir);
    expect(stats.totalSavings).toBe(0);
    expect(stats.totalHypotheticalCost).toBeCloseTo(0.1);
    expect(stats.averageSavingsPercentage).toBe(0);
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

  it('does not leave a temporary stats file after write', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const files = readdirSync(join(testDir, '.splitbrief'));
    expect(files).toContain('stats.json');
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('does not leave a lock file behind after a serialized update', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const files = readdirSync(join(testDir, '.splitbrief'));
    expect(files.some((file) => file.endsWith('.lock'))).toBe(false);
  });
});
