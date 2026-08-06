import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getApiProviderDescriptor } from '../src/core/providers/api-provider-catalog.js';
import { getKnownProviderBaseURL } from '../src/core/providers/catalog.js';
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
import {
  collectGreenRunAggregates,
  collectRunMetrics,
  compareScenario,
  type EvalReport,
  type ReviewMetrics,
  type RunMetrics,
  type ScenarioComparison,
} from './metrics.js';
import { formatCliSummary, generateReport } from './report.js';
import { resolveEvalConnection } from './connection.js';
import {
  aggregateComparisons,
  buildEvalConfig,
  copyScenarioFixture,
  createEvalModelCache,
  formatRunProgressLine,
  preserveSessionArtifacts,
  runInEvalSandbox,
} from './runner.js';
import { calculateCostBreakdown } from '../src/engine/providers/cost/breakdown.js';
import { lookupModelsDevModel } from '../src/engine/providers/model/resolution.js';
import type { ModelsDevCatalogSnapshot } from '../src/engine/providers/models-dev-cache.js';
import { ConfigSchema } from '../src/core/schemas/config.js';
import type { QualityCheckResult } from './scenarios/types.js';
import { ReviewVerdictSchema, type Summary } from '../src/core/schemas/summary.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import { taskId } from '../src/core/schemas/task.js';
import type { TaskTokenUsage } from '../src/core/schemas/tokens.js';

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
      null,
    );
    const routedQuality: QualityCheckResult[] = [
      { passed: true, detail: 'ok' },
      { passed: false, detail: 'missing edge case' },
    ];
    const routed = collectRunMetrics(
      'fake',
      'routed',
      makeSummary(0.04),
      [],
      routedQuality,
      90,
      null,
    );

    const comparison = compareScenario('fake', 'Fake scenario', baseline, routed);

    expect(comparison.costSavingsPercent).toBe(60);
    expect(comparison.qualityRetentionPercent).toBe(50);
    expect(comparison.savingsUSD).toBeCloseTo(0.06);
    expect(routed.quality.failedChecks).toEqual(['missing edge case']);
  });

  it('reports pricing available only for a run whose usage was priced and whose total is known', () => {
    const noBreakdown = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0, { costBreakdown: undefined }),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
      null,
    );
    const unpriced = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0, {
        costBreakdown: {
          hypotheticalCost: 0,
          actualPlannerCost: 0,
          actualImplementerCost: 0,
          totalActualCost: 0,
          savingsAmount: 0,
          savingsPercentage: 0,
          localCompletionRate: 1,
          hasPricedUsage: false,
          hasUnpricedUsage: true,
          isTotalActualCostKnown: false,
        },
      }),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
      null,
    );
    const partlyPriced = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0.1, {
        costBreakdown: {
          hypotheticalCost: 0.2,
          actualPlannerCost: 0.1,
          actualImplementerCost: 0,
          totalActualCost: 0.1,
          savingsAmount: 0,
          savingsPercentage: 0,
          localCompletionRate: 1,
          hasPricedUsage: true,
          hasUnpricedUsage: true,
          isTotalActualCostKnown: false,
        },
      }),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
      null,
    );
    const priced = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0.1),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
      null,
    );

    expect(noBreakdown.cost.pricingAvailable).toBe(false);
    expect(unpriced.cost.pricingAvailable).toBe(false);
    expect(partlyPriced.cost.pricingAvailable).toBe(false);
    expect(priced.cost.costBreakdown?.hasPricedUsage).toBe(true);
    expect(priced.cost.pricingAvailable).toBe(true);
  });

  it('reports pricing unavailable for a zero-token run even though its total cost is knowable', () => {
    const tokenUsage = {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const costBreakdown = calculateCostBreakdown({
      tokenUsage,
      totalTasks: 0,
      escalatedCount: 0,
      plannerTool: 'openai',
      implementerTool: 'openai',
      plannerModel: 'gpt-4o',
      implementerModel: 'gpt-4o-mini',
    });

    const metrics = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0, { tokenUsage, costBreakdown }),
      [],
      [{ passed: true, detail: 'ok' }],
      120,
      null,
    );

    expect(costBreakdown.isTotalActualCostKnown).toBe(true);
    expect(metrics.cost.estimatedCostUSD).toBe(0);
    expect(metrics.cost.pricingAvailable).toBe(false);
  });

  it('prints unpriced on the per-run progress line instead of a fabricated dollar figure', () => {
    const priced = formatRunProgressLine(makeRunMetrics({ mode: 'baseline', cost: 0.1 }));
    const unpriced = formatRunProgressLine(
      makeRunMetrics({ mode: 'routed', cost: 0.04, priced: false }),
    );

    expect(priced).toBe('    cost: $0.1000 | quality: 100%');
    expect(unpriced).toBe('    cost: unpriced | quality: 100%');
    expect(unpriced).not.toContain('$');
  });

  it('writes JSON and markdown reports to a chosen output directory', async () => {
    await withTempDir((dir) => {
      const report = makeReport(null);

      const { jsonPath, mdPath } = generateReport(report, dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(json.aggregate.scenariosRun).toBe(1);
      expect(json.aggregate.totalSavingsUSD).toBeCloseTo(0.06);
      expect(json.aggregate.avgBaselineFirstPassRatePercent).toBe(0);
      expect(json.aggregate.avgRoutedFirstPassRatePercent).toBe(0);
      expect(json.aggregate.totalRetryAttempts).toBe(0);
      expect(json.aggregate.totalEscalations).toBe(0);
      expect(markdown).toContain('Fake scenario');
      expect(markdown).toContain('$0.0600');
    });
  });

  it('leads the markdown summary with first-pass and ends it with the cost rows', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const summarySection = markdown.slice(0, markdown.indexOf('## Per-scenario results'));
      const dataRows = summarySection
        .split('\n')
        .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
        .slice(1);

      expect(dataRows[0]).toContain('First-pass (baseline)');
      expect(dataRows[dataRows.length - 1]).toContain('Total savings');
      expect(dataRows[dataRows.length - 4]).toContain('Avg cost savings');
    });
  });

  it('renders cost cells as n/a rather than $0.0000 when nothing was priced', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null, undefined, false), dir);
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(markdown).not.toContain('$0.0000');
      expect(markdown).toContain('| n/a |');
    });
  });

  it('renders every aggregate cost cell as n/a when one scenario of a mixed report was unpriced', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReportOf(mixedPricingScenarios()), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const summary = markdown.slice(0, markdown.indexOf('## Per-scenario results'));

      expect(summary).toContain('| Avg cost savings | n/a |');
      expect(summary).toContain('| Total baseline cost | n/a |');
      expect(summary).toContain('| Total routed cost | n/a |');
      expect(summary).toContain('| Total savings | n/a |');
      expect(markdown).not.toContain('$0.0000');
      expect(markdown.split('\n').find((line) => line.includes('Priced scenario'))).toContain(
        '$0.1000',
      );
    });
  });

  it('withholds the routed and savings aggregates when a routed run was unpriced, keeping the fully priced baseline total', async () => {
    await withTempDir((dir) => {
      const scenario = compareScenario(
        'fix-bug',
        'Routed unpriced',
        makeRunMetrics({ mode: 'baseline', cost: 0.1 }),
        makeRunMetrics({ mode: 'routed', cost: 0.04, priced: false }),
      );
      const { mdPath } = generateReport(makeReportOf([scenario]), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const summary = markdown.slice(0, markdown.indexOf('## Per-scenario results'));

      expect(summary).toContain('| Total baseline cost | $0.1000 |');
      expect(summary).toContain('| Total routed cost | n/a |');
      expect(summary).toContain('| Total savings | n/a |');
      expect(summary).toContain('| Avg cost savings | n/a |');
      expect(markdown).not.toContain('$0.0000');
    });
  });

  it('publishes null in the JSON aggregate for every cost figure the markdown withholds as n/a', async () => {
    await withTempDir((dir) => {
      const scenario = compareScenario(
        'fix-bug',
        'Routed unpriced',
        makeRunMetrics({ mode: 'baseline', cost: 0.1 }),
        makeRunMetrics({ mode: 'routed', cost: 0.04, priced: false }),
      );
      const { jsonPath, mdPath } = generateReport(makeReportOf([scenario]), dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const summary = readFileSync(mdPath, 'utf-8');

      expect(summary).toContain('| Total routed cost | n/a |');
      expect(summary).toContain('| Total savings | n/a |');
      expect(summary).toContain('| Avg cost savings | n/a |');
      expect(json.aggregate.totalRoutedCostUSD).toBeNull();
      expect(json.aggregate.totalSavingsUSD).toBeNull();
      expect(json.aggregate.avgCostSavingsPercent).toBeNull();
      expect(json.aggregate.totalBaselineCostUSD).toBeCloseTo(0.1);
      expect(json.aggregate.scenariosRun).toBe(1);
    });
  });

  it('publishes null for every JSON cost figure when no run in the report was priced', async () => {
    await withTempDir((dir) => {
      const { jsonPath } = generateReport(makeReport(null, undefined, false), dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));

      expect(json.aggregate.totalBaselineCostUSD).toBeNull();
      expect(json.aggregate.totalRoutedCostUSD).toBeNull();
      expect(json.aggregate.totalSavingsUSD).toBeNull();
      expect(json.aggregate.avgCostSavingsPercent).toBeNull();
    });
  });

  it('renders the totals for a fully priced report', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null), dir);
      const summary = readFileSync(mdPath, 'utf-8');

      expect(summary).toContain('| Avg cost savings | 60% |');
      expect(summary).toContain('| Total baseline cost | $0.1000 |');
      expect(summary).toContain('| Total routed cost | $0.0400 |');
      expect(summary).toContain('| Total savings | $0.0600 |');
    });
  });

  it('rounds the aggregate first-pass delta to one decimal instead of publishing the raw subtraction', async () => {
    await withTempDir((dir) => {
      const scenario = compareScenario(
        'fake',
        'Fake scenario',
        makeRunMetrics({ mode: 'baseline', cost: 0.1, summary: firstPassOfThree(1) }),
        makeRunMetrics({ mode: 'routed', cost: 0.04, summary: firstPassOfThree(2) }),
      );
      const report = makeReportOf([scenario]);
      const { mdPath } = generateReport(report, dir);
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(report.aggregate.avgBaselineFirstPassRatePercent).toBe(33.3);
      expect(report.aggregate.avgRoutedFirstPassRatePercent).toBe(66.7);
      expect(markdown).toContain('| First-pass Δ (routed − baseline) | +33.4pp |');
    });
  });

  it('excludes unpriced runs from the aggregate totals instead of averaging in a fabricated zero', () => {
    const mixed = aggregateComparisons(mixedPricingScenarios());
    expect(mixed.avgCostSavingsPercent).toBe(60);
    expect(mixed.totalBaselineCostUSD).toBeCloseTo(0.1);
    expect(mixed.totalRoutedCostUSD).toBeCloseTo(0.04);
    expect(mixed.totalSavingsUSD).toBeCloseTo(0.06);

    const routedUnpriced = aggregateComparisons([
      compareScenario(
        'fix-bug',
        'Routed unpriced',
        makeRunMetrics({ mode: 'baseline', cost: 0.1 }),
        makeRunMetrics({ mode: 'routed', cost: 0.04, priced: false }),
      ),
    ]);
    expect(routedUnpriced.totalRoutedCostUSD).toBeNull();
    expect(routedUnpriced.totalSavingsUSD).toBeNull();
    expect(routedUnpriced.avgCostSavingsPercent).toBeNull();
  });

  it('renders an unknown review verdict as unknown in the scenario table, never as pass', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const tableRow = markdown.split('\n').find((line) => line.includes('Fake scenario'));

      expect(tableRow).toBeDefined();
      expect(tableRow).toContain('| unknown | unknown |');
    });
  });

  it('renders the recorded verdict in the scenario table next to an unknown run', async () => {
    await withTempDir((dir) => {
      const baseline = collectRunMetrics(
        'fake',
        'baseline',
        makeSummary(0.1, {
          reviewPacket: {
            jsonPath: 'review-packet.json',
            markdownPath: 'review-packet.md',
            generatedAt: '2026-08-05T00:00:00.000Z',
            finalReviewStatus: 'written',
            finalReviewVerdict: 'fail',
            finalReviewFindingCounts: { critical: 1, warning: 0, note: 0 },
            driftPassed: true,
            evidenceValidatedTasks: 1,
            evidenceTotalTasks: 1,
            missingArtifactCount: 0,
          },
        }),
        [],
        [{ passed: true, detail: 'ok' }],
        100,
        null,
      );
      const { mdPath } = generateReport(makeReport(null, baseline), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const tableRow = markdown.split('\n').find((line) => line.includes('Fake scenario'));

      expect(tableRow).toBeDefined();
      expect(tableRow).toContain('| fail | unknown |');
    });
  });

  it('renders the review-yield row directly after the first-pass rows with the planner/implementer pairing', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const summarySection = markdown.slice(0, markdown.indexOf('## Per-scenario results'));
      const dataRows = summarySection
        .split('\n')
        .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
        .slice(1);
      const yieldRow = dataRows.find((row) => row.includes('Review yield'));

      expect(yieldRow).toBeDefined();
      expect(dataRows[3]).toContain('Review yield');
      expect(yieldRow).toContain('planner: planner-model');
      expect(yieldRow).toContain('baseline implementer: baseline-model');
      expect(yieldRow).toContain('routed implementer: routed-model');
    });
  });

  it('prints first-pass rates first on the CLI and the cost line last, saying unpriced when nothing was priced', () => {
    const lines = formatCliSummary(makeReport(null));
    expect(lines[0]).toBe('First-pass (baseline): 0%');
    expect(lines[lines.length - 1]).toBe('Total savings: $0.0600');

    const unpriced = formatCliSummary(makeReport(null, undefined, false));
    expect(unpriced[0]).toBe('First-pass (baseline): 0%');
    expect(unpriced[unpriced.length - 1]).toBe('Total savings: unpriced');
  });

  it('prints the review line second on the CLI, after first-pass and before cost', () => {
    const lines = formatCliSummary(makeReport(null));
    expect(lines[2]).toContain('Review yield:');
    expect(lines[2]).toContain('planner: planner-model');
    expect(lines[2]).toContain('routed implementer: routed-model');
    const avgCostIndex = lines.findIndex((line) => line.startsWith('Avg cost savings'));
    expect(avgCostIndex).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith('Review yield')),
    );
  });

  it('keeps raw events out of the report while still deriving the retry count', async () => {
    await withTempDir((dir) => {
      const retryEvents: EngineEvent[] = [
        {
          type: 'task_retry',
          ts: 1,
          phase: 'implementing',
          taskId: taskId('T001'),
          attempt: 1,
          maxRetries: 1,
          error: 'validation failed',
        },
      ];
      const metrics = collectRunMetrics(
        'fake',
        'baseline',
        makeSummary(0.1),
        retryEvents,
        [{ passed: true, detail: 'ok' }],
        100,
        null,
      );

      expect(metrics.retryCount).toBe(1);
      expect(metrics).not.toHaveProperty('events');

      const report = makeReport(null, metrics);
      const { jsonPath } = generateReport(report, dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));

      expect(JSON.stringify(json)).not.toContain('task_retry');
      expect(json.scenarios[0].baseline.retryCount).toBe(1);
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

  it('makes the copied fixture resolve the repo dependencies, including its test runner binary', async () => {
    const fixtureDir = join(REPO_ROOT, 'evals/fixtures/add-validation');
    const copied = copyScenarioFixture({ id: 'add-validation', fixtureDir }, 'baseline');
    try {
      expect(existsSync(join(copied.projectDir, 'node_modules'))).toBe(true);
      expect(existsSync(join(copied.projectDir, 'node_modules', 'zod'))).toBe(true);
      expect(existsSync(join(copied.projectDir, 'node_modules', '.bin', 'tsx'))).toBe(true);
    } finally {
      rmSync(copied.tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves the source fixture free of node_modules after the copy', () => {
    const fixtureDir = join(REPO_ROOT, 'evals/fixtures/add-validation');
    const copied = copyScenarioFixture({ id: 'add-validation', fixtureDir }, 'baseline');
    try {
      expect(existsSync(join(fixtureDir, 'node_modules'))).toBe(false);
    } finally {
      rmSync(copied.tmpDir, { recursive: true, force: true });
    }
  });

  it('copies a run session directory out under the output path keyed by scenario and mode', async () => {
    await withTempDir((dir) => {
      const projectDir = join(dir, 'project');
      const sessionDirectory = join(projectDir, '.splitbrief', 'sessions', '2026-08-05-eval');
      mkdirSync(sessionDirectory, { recursive: true });
      writeFileSync(join(sessionDirectory, 'review.md'), '# review');
      writeFileSync(join(sessionDirectory, 'review-packet.json'), '{"review":"packet"}');

      const preserved = preserveSessionArtifacts({
        projectDir,
        sessionId: '2026-08-05-eval',
        outputDir: join(dir, 'results'),
        scenarioId: 'fake',
        mode: 'baseline',
      });

      expect(preserved).toBe(join(dir, 'results', 'sessions', 'fake', 'baseline'));
      if (preserved === null) throw new Error('expected a preserved session directory');
      expect(readFileSync(join(preserved, 'review.md'), 'utf-8')).toBe('# review');
      expect(readFileSync(join(preserved, 'review-packet.json'), 'utf-8')).toBe(
        '{"review":"packet"}',
      );
    });
  });

  it('preserves the session artifacts of a run that threw before deleting the project copy', async () => {
    await withTempDir(async (dir) => {
      const tmpDir = join(dir, 'sandbox');
      const projectDir = join(tmpDir, 'project');
      const outputDir = join(dir, 'results');
      const failure = new Error('quality check exploded');

      await expect(
        runInEvalSandbox(
          { tmpDir, projectDir, outputDir, scenarioId: 'fix-bug', mode: 'baseline' },
          async (adoptSession) => {
            writeSessionArtifacts(projectDir, '2026-08-05-eval');
            adoptSession('2026-08-05-eval');
            throw failure;
          },
        ),
      ).rejects.toBe(failure);

      expect(existsSync(tmpDir)).toBe(false);
      expect(
        readFileSync(join(outputDir, 'sessions', 'fix-bug', 'baseline', 'review.md'), 'utf-8'),
      ).toBe('# review');
      expect(existsSync(join(outputDir, 'sessions', 'fix-bug', 'baseline', 'session.jsonl'))).toBe(
        true,
      );
    });
  });

  it('returns the preserved artifacts path of a run that completed', async () => {
    await withTempDir(async (dir) => {
      const tmpDir = join(dir, 'sandbox');
      const projectDir = join(tmpDir, 'project');
      const outputDir = join(dir, 'results');

      const outcome = await runInEvalSandbox(
        { tmpDir, projectDir, outputDir, scenarioId: 'fix-bug', mode: 'routed' },
        async (adoptSession) => {
          writeSessionArtifacts(projectDir, '2026-08-05-eval');
          adoptSession('2026-08-05-eval');
          return 'done';
        },
      );

      expect(outcome.value).toBe('done');
      expect(outcome.sessionArtifactsDir).toBe(join(outputDir, 'sessions', 'fix-bug', 'routed'));
      expect(existsSync(tmpDir)).toBe(false);
    });
  });

  it('raises the run failure, not the preservation failure, when the artifacts cannot be copied', async () => {
    await withTempDir(async (dir) => {
      const tmpDir = join(dir, 'sandbox');
      const projectDir = join(tmpDir, 'project');
      writeFileSync(join(dir, 'blocked'), 'not a directory');
      const failure = new Error('quality check exploded');

      await expect(
        runInEvalSandbox(
          {
            tmpDir,
            projectDir,
            outputDir: join(dir, 'blocked', 'results'),
            scenarioId: 'fix-bug',
            mode: 'baseline',
          },
          async (adoptSession) => {
            writeSessionArtifacts(projectDir, '2026-08-05-eval');
            adoptSession('2026-08-05-eval');
            throw failure;
          },
        ),
      ).rejects.toBe(failure);

      expect(existsSync(tmpDir)).toBe(false);
    });
  });

  it('reports no preserved artifacts when the run never created a session directory', () => {
    const preserved = preserveSessionArtifacts({
      projectDir: join(tmpdir(), 'splitbrief-eval-never'),
      sessionId: '2026-08-05-never',
      outputDir: join(tmpdir(), 'splitbrief-eval-results-never'),
      scenarioId: 'fake',
      mode: 'routed',
    });

    expect(preserved).toBeNull();
  });

  it('records the preserved session artifacts path in the generated report JSON', async () => {
    await withTempDir((dir) => {
      const artifactsDir = join(dir, 'results', 'sessions', 'fake', 'baseline');
      const report = makeReport(artifactsDir);
      const { jsonPath } = generateReport(report, dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));

      expect(json.scenarios[0].baseline.sessionArtifactsDir).toBe(artifactsDir);
      expect(json.scenarios[0].routed.sessionArtifactsDir).toBeNull();
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

  it('builds a loadable v3 config with catalog service and offering on both runners', () => {
    const config = buildEvalConfig(makeModelPair(), 'routed');

    expect(config.planner.kind).toBe('api');
    expect(config.implementer.kind).toBe('api');
    if (config.planner.kind !== 'api' || config.implementer.kind !== 'api') {
      throw new Error('expected API runners');
    }
    expect(config.planner.provider).toBe('openai');
    expect(config.planner.service).toBe('openai');
    expect(config.planner.offering).toBe('payg');
    expect(config.implementer.service).toBe('openai');
    expect(config.implementer.offering).toBe('payg');
    expect(config.planner.apiBase).toBe('https://api.example.test/v1');
    expect(config.workflow.mode).toBe('quick');
  });

  it('selects the baseline implementer model in baseline mode and the routed model in routed mode', () => {
    const pair = makeModelPair();

    expect(buildEvalConfig(pair, 'baseline').implementer.model).toBe('baseline-model');
    expect(buildEvalConfig(pair, 'routed').implementer.model).toBe('routed-model');
  });

  it('rejects an unknown provider and names the admissible providers', () => {
    const pair = { ...makeModelPair(), provider: 'not-a-catalog-provider' };

    expect(() => buildEvalConfig(pair, 'baseline')).toThrow(
      /"not-a-catalog-provider".*(openai|anthropic|openrouter)/,
    );
  });

  it('rejects a catalog provider only one eval role admits, instead of failing schema parsing', () => {
    for (const provider of ['ollama', 'lm-studio']) {
      const pair = { ...makeModelPair(), provider };

      expect(() => buildEvalConfig(pair, 'baseline')).toThrow(
        expect.objectContaining({ kind: 'eval-provider-not-usable-for-both-roles' }),
      );
      expect(() => buildEvalConfig(pair, 'baseline')).toThrow(
        new RegExp(`"${provider}".*not usable for both eval roles.*openai`),
      );
    }
  });

  it('prices each run from its own catalog snapshot instead of one shared process-global catalog', () => {
    const routed = createEvalModelCache(
      catalogSnapshot({ provider: 'openai', model: 'gpt-4o-mini', input: 0.15, output: 0.6 }),
    );
    const baseline = createEvalModelCache(
      catalogSnapshot({ provider: 'anthropic', model: 'claude-opus-5', input: 5, output: 25 }),
    );

    expect(Object.keys(routed.getModelsDevCatalog() ?? {})).toEqual(['openai']);
    expect(Object.keys(baseline.getModelsDevCatalog() ?? {})).toEqual(['anthropic']);
    expect(lookupModelsDevModel('openai', 'gpt-4o-mini', routed)).toMatchObject({
      pricingInput: 0.15,
      pricingOutput: 0.6,
    });
    expect(lookupModelsDevModel('anthropic', 'claude-opus-5', baseline)).toMatchObject({
      pricingInput: 5,
      pricingOutput: 25,
    });
    expect(lookupModelsDevModel('anthropic', 'claude-opus-5', routed)).toBeNull();
    expect(routed.getProviderModels('openai')).toBeNull();
  });

  it('keeps the harness out of every app layer the engine may not import, at any nesting depth', () => {
    const importsAppLayer = /from '(?:\.\.\/)+src\/(?:stores|components|hooks|features|cli)\//;
    const harnessFiles = harnessSourceFiles();
    const offenders = harnessFiles.filter((file) =>
      importsAppLayer.test(readFileSync(join(REPO_ROOT, file), 'utf-8')),
    );

    expect(harnessFiles).toContain('evals/runner.ts');
    expect(harnessFiles).toContain('evals/scenarios/fix-bug.ts');
    expect(offenders).toEqual([]);
    expect(
      [
        "import { x } from '../src/stores/a.js';",
        "import { x } from '../../src/stores/a.js';",
        "import { x } from '../../src/cli/a.js';",
        "import type { X } from '../../src/features/a/b.js';",
      ].filter((line) => !importsAppLayer.test(line)),
    ).toEqual([]);
    expect(importsAppLayer.test("import { x } from '../src/engine/a.js';")).toBe(false);
  });
});

describe('outcome metrics', () => {
  it('counts a task as first-pass only when it completed locally with zero retries', () => {
    const summary = makeSummary(0, {
      totalTasks: 4,
      completedByLocal: 1,
      escalatedToPlanner: 2,
      taskBreakdown: [
        breakdownEntry('T001', 'local', 0),
        breakdownEntry('T002', 'local', 2),
        breakdownEntry('T003', 'escalated-hint', 0),
        breakdownEntry('T004', 'escalated-full', 1),
      ],
    });

    const metrics = collectRunMetrics('fake', 'baseline', summary, [], [], 100, null);

    expect(metrics.outcome.firstPassTasks).toBe(1);
    expect(metrics.outcome.retriedTasks).toBe(2);
    expect(metrics.outcome.escalatedTasks).toBe(2);
  });

  it('counts every escalation attempt from the events while the summary counts only completions', () => {
    const escalations: EngineEvent[] = [
      { type: 'escalate', ts: 1, phase: 'implementing', taskId: taskId('T001'), tier: 1 },
      { type: 'escalate', ts: 2, phase: 'implementing', taskId: taskId('T001'), tier: 2 },
    ];

    const metrics = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0.1, { escalatedToPlanner: 0 }),
      escalations,
      [{ passed: true, detail: 'ok' }],
      100,
      null,
    );
    const aggregate = aggregateComparisons([
      compareScenario(
        'fake',
        'Fake scenario',
        metrics,
        makeRunMetrics({ mode: 'routed', cost: 0.04 }),
      ),
    ]);

    expect(metrics.outcome.escalationAttempts).toBe(2);
    expect(metrics.outcome.escalatedTasks).toBe(0);
    expect(aggregate.totalEscalations).toBe(2);
    expect(aggregate.totalEscalationCompletions).toBe(0);
  });

  it('divides first-pass tasks by the run total, not by completed tasks', () => {
    const summary = makeSummary(0, {
      totalTasks: 4,
      completedByLocal: 2,
      taskBreakdown: [breakdownEntry('T001', 'local', 0), breakdownEntry('T002', 'local', 0)],
    });

    const metrics = collectRunMetrics('fake', 'baseline', summary, [], [], 100, null);

    expect(metrics.outcome.firstPassTasks).toBe(2);
    expect(metrics.outcome.firstPassRate).toBe(0.5);
  });

  it('takes failed and skipped counts from the summary when the total exceeds breakdown plus failed plus skipped', () => {
    const summary = makeSummary(0, {
      totalTasks: 10,
      completedByLocal: 3,
      skipped: 2,
      failed: 2,
      taskBreakdown: [
        breakdownEntry('T001', 'local', 0),
        breakdownEntry('T002', 'local', 1),
        breakdownEntry('T003', 'local', 0),
      ],
    });

    const metrics = collectRunMetrics('fake', 'baseline', summary, [], [], 100, null);

    expect(metrics.outcome.failedTasks).toBe(2);
    expect(metrics.outcome.skippedTasks).toBe(2);
  });

  it('treats an absent task breakdown as an empty list, never as zero total tasks', () => {
    const summary = makeSummary(0, { totalTasks: 2, completedByLocal: 0 });

    const metrics = collectRunMetrics('fake', 'baseline', summary, [], [], 100, null);

    expect(metrics.outcome.totalTasks).toBe(2);
    expect(metrics.outcome.firstPassTasks).toBe(0);
    expect(metrics.outcome.firstPassRate).toBe(0);
  });

  it('reports the routed-minus-baseline first-pass difference in percentage points', () => {
    const baseline = collectRunMetrics(
      'fake',
      'baseline',
      makeSummary(0, {
        totalTasks: 4,
        completedByLocal: 1,
        taskBreakdown: [breakdownEntry('T001', 'local', 0)],
      }),
      [],
      [],
      100,
      null,
    );
    const routed = collectRunMetrics(
      'fake',
      'routed',
      makeSummary(0, {
        totalTasks: 2,
        completedByLocal: 1,
        taskBreakdown: [breakdownEntry('T001', 'local', 0)],
      }),
      [],
      [],
      100,
      null,
    );

    const comparison = compareScenario('fake', 'Fake scenario', baseline, routed);

    expect(baseline.outcome.firstPassRate).toBe(0.25);
    expect(routed.outcome.firstPassRate).toBe(0.5);
    expect(comparison.firstPassRateDeltaPercent).toBe(25);
  });
});

describe('review metrics', () => {
  function summaryWithReviewPacket(
    verdict: ReviewMetrics['verdict'],
    findingCounts: { critical: number; warning: number; note: number },
    overrides: Partial<Summary> = {},
  ): Summary {
    return makeSummary(0, {
      ...overrides,
      reviewPacket: {
        jsonPath: 'review-packet.json',
        markdownPath: 'review-packet.md',
        generatedAt: '2026-08-05T00:00:00.000Z',
        finalReviewStatus: 'written',
        finalReviewVerdict: verdict,
        finalReviewFindingCounts: findingCounts,
        driftPassed: true,
        evidenceValidatedTasks: 1,
        evidenceTotalTasks: 1,
        missingArtifactCount: 0,
      },
    });
  }

  it('reports the review findings and marks the run validation-green', () => {
    const metrics = collectRunMetrics(
      'fake',
      'baseline',
      summaryWithReviewPacket('fail', { critical: 1, warning: 2, note: 3 }),
      [],
      [],
      100,
      null,
    );

    expect(metrics.review.verdict).toBe('fail');
    expect(metrics.review.criticalFindings).toBe(1);
    expect(metrics.review.warningFindings).toBe(2);
    expect(metrics.review.noteFindings).toBe(3);
    expect(metrics.review.validationGreen).toBe(true);
  });

  it('still reports the same findings on a run with a failure, with validation-green false', () => {
    const metrics = collectRunMetrics(
      'fake',
      'baseline',
      summaryWithReviewPacket(
        'pass_with_notes',
        { critical: 0, warning: 1, note: 3 },
        { failed: 1 },
      ),
      [],
      [],
      100,
      null,
    );

    expect(metrics.review.verdict).toBe('pass_with_notes');
    expect(metrics.review.criticalFindings).toBe(0);
    expect(metrics.review.warningFindings).toBe(1);
    expect(metrics.review.noteFindings).toBe(3);
    expect(metrics.review.validationGreen).toBe(false);
  });

  it('carries every verdict the review schema admits', () => {
    const carried = ReviewVerdictSchema.options.map(
      (verdict) =>
        collectRunMetrics(
          'fake',
          'baseline',
          summaryWithReviewPacket(verdict, { critical: 0, warning: 0, note: 0 }),
          [],
          [],
          100,
          null,
        ).review.verdict,
    );

    expect(carried).toEqual([...ReviewVerdictSchema.options]);
  });

  it('yields an unknown verdict and zero counts when there is no review packet', () => {
    const metrics = collectRunMetrics('fake', 'baseline', makeSummary(0), [], [], 100, null);

    expect(metrics.review.verdict).toBeNull();
    expect(metrics.review.criticalFindings).toBe(0);
    expect(metrics.review.warningFindings).toBe(0);
    expect(metrics.review.noteFindings).toBe(0);
  });

  it('excludes zero-task runs from the green-run aggregate', () => {
    const greenWithFindings = collectRunMetrics(
      'fake',
      'baseline',
      summaryWithReviewPacket('pass_with_notes', { critical: 2, warning: 0, note: 0 }),
      [],
      [],
      100,
      null,
    );
    const greenWithoutFindings = collectRunMetrics(
      'fake',
      'routed',
      summaryWithReviewPacket('pass', { critical: 0, warning: 0, note: 0 }),
      [],
      [],
      100,
      null,
    );
    const greenZeroTaskWithFindings = collectRunMetrics(
      'fake',
      'baseline',
      summaryWithReviewPacket(
        'pass_with_notes',
        { critical: 1, warning: 0, note: 0 },
        { totalTasks: 0, completedByLocal: 0 },
      ),
      [],
      [],
      100,
      null,
    );
    const failedWithFindings = collectRunMetrics(
      'fake',
      'routed',
      summaryWithReviewPacket('fail', { critical: 3, warning: 0, note: 0 }, { failed: 1 }),
      [],
      [],
      100,
      null,
    );

    const comparisons = [
      compareScenario('green', 'Green', greenWithFindings, greenWithoutFindings),
      compareScenario('zero-task', 'Zero-task', greenZeroTaskWithFindings, failedWithFindings),
    ];

    const aggregates = collectGreenRunAggregates(comparisons);

    expect(aggregates.greenRunsWithFindings).toBe(1);
    expect(aggregates.greenRunsCriticalFindings).toBe(2);
  });
});

describe('eval connection resolution', () => {
  it('fills an empty base URL from the provider catalog', () => {
    const resolved = resolveEvalConnection({
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });

    expect(resolved.baseUrl).toBe(getKnownProviderBaseURL('openai'));
  });

  it('keeps an explicitly given base URL instead of filling from the catalog', () => {
    const resolved = resolveEvalConnection({
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: '',
      replay: true,
    });

    expect(resolved.baseUrl).toBe('https://api.example.test/v1');
  });

  it('fills a prefix-correct placeholder credential in replay mode so admission is not blocked', () => {
    for (const provider of ['openai', 'groq', 'anthropic']) {
      const prefix = getApiProviderDescriptor(provider)?.credentialPrefix;
      expect(prefix).toBeTruthy();
      const resolved = resolveEvalConnection({ provider, baseUrl: '', apiKey: '', replay: true });
      expect(resolved.apiKey).toBe(`${prefix}eval-replay`);
    }

    const noPrefix = resolveEvalConnection({
      provider: 'together',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });
    expect(noPrefix.apiKey).toBe('eval-replay');
  });

  it('fills a loopback provider with a credential the config schema accepts, inventing none', () => {
    const ollama = resolveEvalConnection({
      provider: 'ollama',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });
    const lmStudio = resolveEvalConnection({
      provider: 'lm-studio',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });

    const ollamaParsed = ConfigSchema.safeParse(localImplementerConfig('ollama', ollama));
    const lmStudioParsed = ConfigSchema.safeParse(localImplementerConfig('lm-studio', lmStudio));

    expect(ollamaParsed.error).toBeUndefined();
    expect(lmStudioParsed.error).toBeUndefined();
    expect(lmStudio.apiKey).toBe('');
  });

  it('requires a real credential outside replay mode', () => {
    expect(() =>
      resolveEvalConnection({ provider: 'openai', baseUrl: '', apiKey: '', replay: false }),
    ).toThrow(expect.objectContaining({ kind: 'eval-api-key-required' }));
  });

  it('reports a provider without a default endpoint instead of guessing', () => {
    expect(() =>
      resolveEvalConnection({ provider: 'not-a-provider', baseUrl: '', apiKey: '', replay: true }),
    ).toThrow(expect.objectContaining({ kind: 'eval-provider-no-default-endpoint' }));
  });
});

function localImplementerConfig(
  provider: 'ollama' | 'lm-studio',
  connection: { baseUrl: string; apiKey: string },
) {
  return {
    version: 3,
    planner: {
      kind: 'api',
      provider: 'openai',
      service: 'openai',
      offering: 'payg',
      apiBase: 'https://api.example.test/v1',
      model: 'planner-model',
      apiKey: 'secret',
    },
    implementer: {
      kind: 'api',
      provider,
      service: provider,
      offering: 'local',
      apiBase: connection.baseUrl,
      model: 'local-model',
      apiKey: connection.apiKey,
    },
    validation: { typecheck: true, lint: false, test: true, testCommand: 'npm test' },
    workflow: { maxRetries: 1, mode: 'quick', persistTranscript: true },
  };
}

function makeModelPair() {
  return {
    plannerModel: 'planner-model',
    baselineImplementerModel: 'baseline-model',
    routedImplementerModel: 'routed-model',
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'secret',
  };
}

function catalogSnapshot(input: {
  provider: string;
  model: string;
  input: number;
  output: number;
}): ModelsDevCatalogSnapshot {
  return {
    sourceUrl: 'https://models.dev/api.json',
    parserVersion: 'models-dev-api-json-v1',
    catalog: {
      [input.provider]: {
        id: input.provider,
        models: {
          [input.model]: { id: input.model, cost: { input: input.input, output: input.output } },
        },
      },
    },
    catalogState: 'populated',
    fetchedAt: 1_700_000_000_000,
    validatedAt: 1_700_000_000_500,
  };
}

function harnessSourceFiles(): string[] {
  return readdirSync(join(REPO_ROOT, 'evals'), { recursive: true, encoding: 'utf-8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .filter((entry) => !entry.startsWith('fixtures/'))
    .map((entry) => join('evals', entry));
}

function perfectScenarioMetrics(): ModelEvaluationScenarioMetrics {
  return {
    compileTest: { passed: 5, total: 5 },
    extraction: { passed: 5, total: 5 },
    instructionAdherence: { passed: 5, total: 5 },
    unnecessaryFiles: 0,
    retryRate: 0,
  };
}

function makeSummary(totalActualCost: number, overrides: Partial<Summary> = {}): Summary {
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
      hasPricedUsage: totalActualCost > 0,
    },
    ...overrides,
  };
}

function writeSessionArtifacts(projectDir: string, sessionId: string): void {
  const sessionDirectory = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, 'review.md'), '# review');
  writeFileSync(join(sessionDirectory, 'session.jsonl'), '{"type":"escalate"}\n');
}

function breakdownEntry(
  taskNumber: string,
  method: TaskTokenUsage['method'],
  retryCount: number,
): TaskTokenUsage {
  return {
    taskId: taskId(taskNumber),
    taskTitle: 'fake task',
    method,
    implementerTokens: 0,
    escalationTokens: 0,
    retryCount,
  };
}

function makeRunMetrics(input: {
  mode: 'baseline' | 'routed';
  cost: number;
  sessionArtifactsDir?: string | null;
  priced?: boolean;
  summary?: Partial<Summary>;
}): RunMetrics {
  const priced = input.priced ?? true;
  return collectRunMetrics(
    'fake',
    input.mode,
    makeSummary(input.cost, {
      ...(priced ? {} : { costBreakdown: undefined }),
      ...input.summary,
    }),
    [],
    [{ passed: true, detail: 'ok' }],
    100,
    input.sessionArtifactsDir ?? null,
  );
}

function firstPassOfThree(firstPassTasks: number): Partial<Summary> {
  return {
    totalTasks: 3,
    taskBreakdown: [0, 1, 2].map((index) =>
      breakdownEntry(`T00${index + 1}`, 'local', index < firstPassTasks ? 0 : 1),
    ),
  };
}

function mixedPricingScenarios(): ScenarioComparison[] {
  return [
    compareScenario(
      'priced',
      'Priced scenario',
      makeRunMetrics({ mode: 'baseline', cost: 0.1 }),
      makeRunMetrics({ mode: 'routed', cost: 0.04 }),
    ),
    compareScenario(
      'unpriced',
      'Unpriced scenario',
      makeRunMetrics({ mode: 'baseline', cost: 0.2, priced: false }),
      makeRunMetrics({ mode: 'routed', cost: 0.05, priced: false }),
    ),
  ];
}

function makeReportOf(scenarios: ScenarioComparison[]): EvalReport {
  return {
    timestamp: '2026-04-30T12:00:00.000Z',
    plannerModel: 'planner-model',
    baselineImplementerModel: 'baseline-model',
    routedImplementerModel: 'routed-model',
    scenarios,
    aggregate: aggregateComparisons(scenarios),
  };
}

function makeReport(
  sessionArtifactsDir: string | null,
  baseline?: RunMetrics,
  priced = true,
): EvalReport {
  const baselineMetrics =
    baseline ?? makeRunMetrics({ mode: 'baseline', cost: 0.1, sessionArtifactsDir, priced });
  const routed = makeRunMetrics({ mode: 'routed', cost: 0.04, priced });
  return makeReportOf([compareScenario('fake', 'Fake scenario', baselineMetrics, routed)]);
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'splitbrief-eval-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
