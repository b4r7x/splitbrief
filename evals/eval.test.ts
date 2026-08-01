import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_MODELS,
  PENDING_EVALUATION_CANDIDATE_IDS,
} from '../src/core/providers/known-models.js';
import {
  MODEL_EVALUATION_OMIT_ROWS,
  MODEL_EVALUATION_SCENARIO_IDS,
  MODEL_EVALUATION_THRESHOLDS,
  OMIT_PROVIDER_EVALUATION_ROWS,
  buildModelEvaluationEvidence,
  discoverPendingEvaluationCandidates,
  deriveQualityVerdict,
  scenarioMetricsMeetThresholds,
  type ModelEvaluationScenarioMetrics,
} from './implementer-provider.js';
import { collectRunMetrics, compareScenario, type EvalReport, type RunMetrics } from './metrics.js';
import { generateReport } from './report.js';
import { copyScenarioFixture } from './runner.js';
import type { QualityCheckResult } from './scenarios/types.js';
import type { Summary } from '../src/core/schemas/summary.js';
import { ConfigSchema } from '../src/core/schemas/config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_EVALUATION_EVIDENCE_PATH = join(
  REPO_ROOT,
  'testing/fixtures/model-evaluation/model-evaluations.json',
);

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

  it('freezes exactly five configured model-evaluation scenario IDs', () => {
    expect(MODEL_EVALUATION_SCENARIO_IDS).toEqual([
      'typescript-fix',
      'multi-file-esm',
      'react-no-memo',
      'behavior-test',
      'near-limit-brief',
    ]);
  });

  it('discovers pending-evaluation candidates for OpenRouter, Groq, Ollama, and LM Studio', () => {
    expect(discoverPendingEvaluationCandidates()).toEqual(PENDING_EVALUATION_CANDIDATE_IDS);
    expect(discoverPendingEvaluationCandidates()).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
      { provider: 'groq', model: 'openai/gpt-oss-120b' },
      { provider: 'ollama', model: 'qwen3-coder:30b' },
      { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
    ]);
  });

  it('scores a scenario only from supplied metrics and fails a short scenario set', () => {
    expect(scenarioMetricsMeetThresholds(perfectScenarioMetrics())).toBe(true);
    expect(scenarioMetricsMeetThresholds({ ...perfectScenarioMetrics(), retryRate: 0.25 })).toBe(
      false,
    );
    expect(
      scenarioMetricsMeetThresholds({ ...perfectScenarioMetrics(), unnecessaryFiles: 1 }),
    ).toBe(false);
    expect(
      scenarioMetricsMeetThresholds({
        ...perfectScenarioMetrics(),
        extraction: { passed: 4, total: 5 },
      }),
    ).toBe(false);

    const allScenarios = MODEL_EVALUATION_SCENARIO_IDS.map((scenarioId) => ({
      scenarioId,
      metrics: perfectScenarioMetrics(),
      thresholdsMet: true,
    }));
    expect(deriveQualityVerdict(allScenarios)).toBe('PASS');
    expect(deriveQualityVerdict(allScenarios.slice(1))).toBe('FAIL');
    expect(
      deriveQualityVerdict(
        allScenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, thresholdsMet: false } : scenario,
        ),
      ),
    ).toBe('FAIL');
  });

  it('records OMIT-NOT-APPLICABLE for every pending candidate until T-080 runs', () => {
    expect(MODEL_EVALUATION_OMIT_ROWS.map((row) => `${row.provider}/${row.model}`)).toEqual(
      discoverPendingEvaluationCandidates().map(
        (candidate) => `${candidate.provider}/${candidate.model}`,
      ),
    );
    for (const row of MODEL_EVALUATION_OMIT_ROWS) {
      expect(row.resolution).toBe('OMIT-NOT-APPLICABLE');
      expect(row.taskId).toBe('T-080');
    }
  });

  it('records OMIT-NOT-APPLICABLE rows for every OMIT provider verdict', () => {
    expect(OMIT_PROVIDER_EVALUATION_ROWS).toHaveLength(11);
    expect(OMIT_PROVIDER_EVALUATION_ROWS.map((row) => row.taskId)).toEqual([
      'T-043',
      'T-044',
      'T-045',
      'T-046',
      'T-047',
      'T-048',
      'T-049',
      'T-050',
      'T-051',
      'T-052',
      'T-053',
    ]);
    for (const row of OMIT_PROVIDER_EVALUATION_ROWS) {
      expect(row.resolution).toBe('OMIT-NOT-APPLICABLE');
    }
  });

  it('keeps the tracked evidence artifact free of scores and free of applied recommendations', () => {
    const built = buildModelEvaluationEvidence();
    const onDisk = JSON.parse(readFileSync(MODEL_EVALUATION_EVIDENCE_PATH, 'utf-8'));
    expect(onDisk).toEqual(built);
    expect(onDisk.thresholds).toEqual(MODEL_EVALUATION_THRESHOLDS);
    expect(onDisk.candidates).toBeUndefined();
    expect(onDisk.modelEvaluationRows).toHaveLength(PENDING_EVALUATION_CANDIDATE_IDS.length);
    for (const row of onDisk.modelEvaluationRows) {
      expect(row).toMatchObject({ resolution: 'OMIT-NOT-APPLICABLE', taskId: 'T-080' });
      expect(row).not.toHaveProperty('scenarios');
      expect(row).not.toHaveProperty('qualityVerdict');
    }

    const recommended = Object.entries(KNOWN_MODELS).flatMap(([provider, entries]) =>
      (entries ?? [])
        .filter((model) => model.recommendation === 'recommended')
        .map((model) => `${provider}/${model.name}`),
    );
    expect(recommended).toEqual([]);
  });

  it('builds current v3 API configs from eval model options', () => {
    const pair = {
      plannerModel: 'planner-model',
      baselineImplementerModel: 'baseline-model',
      routedImplementerModel: 'routed-model',
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'secret',
    };
    const config = ConfigSchema.parse({
      version: 3,
      planner: {
        kind: 'api',
        provider: pair.provider,
        service: pair.provider,
        offering: 'payg',
        apiBase: pair.baseUrl,
        model: pair.plannerModel,
        apiKey: pair.apiKey,
      },
      implementer: {
        kind: 'api',
        provider: pair.provider,
        service: pair.provider,
        offering: 'payg',
        apiBase: pair.baseUrl,
        model: pair.routedImplementerModel,
        apiKey: pair.apiKey,
      },
      validation: {
        typecheck: true,
        lint: false,
        test: true,
        testCommand: 'npm test',
      },
      workflow: {
        maxRetries: 1,
        mode: 'quick',
        persistTranscript: true,
      },
    });

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

function perfectScenarioMetrics(): ModelEvaluationScenarioMetrics {
  return {
    compileTest: { passed: 5, total: 5 },
    extraction: { passed: 5, total: 5 },
    instructionAdherence: { passed: 5, total: 5 },
    unnecessaryFiles: 0,
    retryRate: 0,
  };
}

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
