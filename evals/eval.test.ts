import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCassetteRecorder } from '../testing/helpers/cassette/recorder.js';
import { createCassetteReplayer, loadCassette } from '../testing/helpers/cassette/replayer.js';
import type { Cassette } from '../testing/helpers/cassette/types.js';
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

  it('writes JSON and markdown reports to a chosen output directory', () => {
    withTempDir((dir) => {
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

  it('records fetch responses while redacting API key headers', async () => {
    const originalFetch = globalThis.fetch;
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = fakeFetch;

    try {
      await withTempDirAsync(async (dir) => {
        const cassettePath = join(dir, 'test-record.json');
        const recorder = createCassetteRecorder(cassettePath, 'test-record');
        recorder.install();
        const response = await fetch('https://example.test/messages', {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret',
            'x-api-key': 'secret-key',
            'content-type': 'application/json',
          },
          body: '{"message":"hello"}',
        });
        await response.text();
        recorder.uninstall();
        const entry = firstEntry(recorder.entries);

        expect(entry.response.status).toBe(201);
        expect(entry.request.headers['authorization']).toBe('***');
        expect(entry.request.headers['x-api-key']).toBe('***');
        expect(entry.request.headers['content-type']).toBe('application/json');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('replays recorded responses and reports cassette exhaustion clearly', async () => {
    await withTempDirAsync(async (dir) => {
      const cassettePath = join(dir, 'fake-baseline.json');
      writeFileSync(cassettePath, JSON.stringify(makeCassette(), null, 2));

      const cassette = loadCassette(cassettePath);
      const replayer = createCassetteReplayer(cassette);
      try {
        replayer.install();
        const response = await fetch('https://example.test/messages', { method: 'POST' });

        expect(response.status).toBe(202);
        expect(await response.text()).toBe('{"message":"replayed"}');
        await expect(fetch('https://example.test/messages', { method: 'POST' })).rejects.toThrow('exhausted');
      } finally {
        replayer.uninstall();
      }
    });
  });

  it('copies fixtures to a temp project without modifying the original fixture', () => {
    withTempDir((dir) => {
      const fixtureDir = join(dir, 'fixture');
      const originalConfig = 'version: 3\n';
      mkdirSync(join(fixtureDir, '.diptych'), { recursive: true });
      writeFileSync(join(fixtureDir, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(fixtureDir, '.diptych/config.yaml'), originalConfig);

      const copied = copyScenarioFixture({ id: 'fake', fixtureDir }, 'baseline');
      try {
        writeFileSync(join(copied.projectDir, '.diptych/config.yaml'), 'changed: true\n');

        expect(readFileSync(join(fixtureDir, '.diptych/config.yaml'), 'utf-8')).toBe(originalConfig);
        expect(readFileSync(join(copied.projectDir, '.diptych/config.yaml'), 'utf-8')).toBe('changed: true\n');
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
    expect(config.planner.provider).toBe('anthropic');
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

function makeCassette(): Cassette {
  return {
    version: 1,
    name: 'fake-baseline',
    recordedAt: '2026-04-30T12:00:00.000Z',
    meta: { scenarioId: 'fake', mode: 'baseline' },
    entries: [
      {
        index: 0,
        recordedAt: '2026-04-30T12:00:01.000Z',
        request: {
          method: 'POST',
          url: 'https://example.test/messages',
          headers: {},
          body: null,
        },
        response: {
          status: 202,
          headers: { 'content-type': 'application/json' },
          body: '{"message":"replayed"}',
        },
        provider: 'unknown',
        durationMs: 10,
      },
    ],
  };
}

function firstEntry<T>(entries: T[]): T {
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error('expected at least one entry');
  }
  return entry;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'diptych-eval-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'diptych-eval-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
