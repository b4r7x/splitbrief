import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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
    mkdirSync(join(testDir, '.diptych'), { recursive: true });
    writeFileSync(join(testDir, '.diptych', 'stats.json'), '{ this is not json');
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const stats = readStats(testDir);

    expect(stats.totalSessions).toBe(0);
    expect(stats.version).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('stats: unreadable file');
    warn.mockRestore();
  });

  it('readStats warns and returns empty stats when the file fails schema validation', () => {
    mkdirSync(join(testDir, '.diptych'), { recursive: true });
    writeFileSync(join(testDir, '.diptych', 'stats.json'), JSON.stringify({ version: 999 }));
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const stats = readStats(testDir);

    expect(stats.totalSessions).toBe(0);
    expect(stats.version).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
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

  it('does not leave a temporary stats file after write', () => {
    updateStats(testDir, {
      costBreakdown: makeCostBreakdown(),
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
    });

    const files = readdirSync(join(testDir, '.diptych'));
    expect(files).toContain('stats.json');
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false);
  });
});
