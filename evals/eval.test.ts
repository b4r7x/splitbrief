import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRunMetrics, compareScenario, type EvalReport, type RunMetrics } from './metrics.js';
import { generateReport } from './report.js';
import { buildEvalConfig, copyScenarioFixture } from './runner.js';
import type { QualityCheckResult } from './scenarios/types.js';
import type { Summary } from '../src/core/schemas/summary.js';

describe('eval harness', () => {
  it('compares fake run metrics for cost savings and quality retention', () => {
    const baseline = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0.1),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
    );
    const routedQuality: QualityCheckResult[] = [
      { passed: true, detail: 'ok' },
      { passed: false, detail: 'missing edge case' },
    ];
    const routed = collectRunMetrics('fake', 'routed', makeSummary(0.04), [], routedQuality, 90);

    const comparison = compareScenario('fake', 'Fake scenario', baseline, routed);

    expect(comparison.costSavingsPercent).toBe(60);
    expect(comparison.qualityRetentionPercent).toBe(50);
    expect(comparison.savingsUSD).toBeCloseTo(0.06);
    expect(routed.quality.failedChecks).toEqual(['missing edge case']);
  });

  it('writes JSON and markdown reports to a chosen output directory', async () => {
    await withTempDir((dir) => {
      const report = makeReport();

      const { jsonPath, mdPath } = generateReport(report, dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(json.aggregate.scenariosRun).toBe(1);
      expect(json.aggregate.totalSavingsUSD).toBe(0.06);
      expect(markdown).toContain('Fake scenario');
      expect(markdown).toContain('$0.0600');
    });
  });

  it('copies fixtures to a temp project without modifying the original fixture', async () => {
    await withTempDir((dir) => {
      const fixtureDir = join(dir, 'fixture');
      const originalConfig = 'version: 3\n';
      mkdirSync(join(fixtureDir, '.splitbrief'), { recursive: true });
      writeFileSync(join(fixtureDir, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(fixtureDir, '.splitbrief/config.yaml'), originalConfig);

      const copied = copyScenarioFixture({ id: 'fake', fixtureDir }, 'baseline');
      try {
        writeFileSync(join(copied.projectDir, '.splitbrief/config.yaml'), 'changed: true\n');

        expect(readFileSync(join(fixtureDir, '.splitbrief/config.yaml'), 'utf-8')).toBe(
          originalConfig,
        );
        expect(readFileSync(join(copied.projectDir, '.splitbrief/config.yaml'), 'utf-8')).toBe(
          'changed: true\n',
        );
      } finally {
        rmSync(copied.tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('builds current v3 API configs from eval model options', () => {
    const config = buildEvalConfig(
      {
        plannerModel: 'planner-model',
        baselineImplementerModel: 'baseline-model',
        routedImplementerModel: 'routed-model',
        provider: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'secret',
      },
      'routed',
    );

    expect(config.planner.kind).toBe('api');
    expect(config.implementer.kind).toBe('api');
    if (config.planner.kind !== 'api' || config.implementer.kind !== 'api') {
      throw new Error('expected API runners');
    }
    expect(config.planner.provider).toBe('openai');
    expect(config.planner.apiBase).toBe('https://api.example.test/v1');
    expect(config.implementer.model).toBe('routed-model');
    expect(config.workflow.mode).toBe('quick');
  });
});

function makeSummary(totalActualCost: number): Summary {
  return {
    feature: 'fake feature',
    totalTasks: 1,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 100,
    tokenUsage: {
      plannerInput: 100,
      plannerOutput: 50,
      implementerInput: 80,
      implementerOutput: 40,
      escalationInput: 0,
      escalationOutput: 0,
    },
    estimatedCostSavings: '60%',
    escalationRate: 0,
    costBreakdown: {
      hypotheticalCost: totalActualCost * 2,
      actualPlannerCost: totalActualCost * 0.6,
      actualImplementerCost: totalActualCost * 0.4,
      totalActualCost,
      savingsAmount: totalActualCost,
      savingsPercentage: 50,
      localCompletionRate: 1,
    },
  };
}

function makeRunMetrics(mode: 'baseline' | 'routed', cost: number): RunMetrics {
  return collectRunMetrics(
    'fake',
    mode,
    makeSummary(cost),
    [],
    [{ passed: true, detail: 'ok' }],
    100,
  );
}

function makeReport(): EvalReport {
  const baseline = makeRunMetrics('baseline', 0.1);
  const routed = makeRunMetrics('routed', 0.04);
  const scenario = compareScenario('fake', 'Fake scenario', baseline, routed);
  return {
    timestamp: '2026-04-30T12:00:00.000Z',
    plannerModel: 'planner-model',
    baselineImplementerModel: 'baseline-model',
    routedImplementerModel: 'routed-model',
    scenarios: [scenario],
    aggregate: {
      avgCostSavingsPercent: 60,
      avgQualityRetentionPercent: 100,
      totalBaselineCostUSD: 0.1,
      totalRoutedCostUSD: 0.04,
      totalSavingsUSD: 0.06,
      scenariosRun: 1,
      scenariosWhereRoutedMatchedBaseline: 1,
    },
  };
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'splitbrief-eval-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
