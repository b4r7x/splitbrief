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
import { PENDING_EVALUATION_CANDIDATE_IDS } from '#testing/helpers/pending-evaluation-candidates.js';
import { KNOWN_MODELS } from '../src/core/providers/known-models.js';
import {
  MODEL_EVALUATION_OMIT_ROWS,
  MODEL_EVALUATION_SCENARIO_IDS,
  MODEL_EVALUATION_THRESHOLDS,
  OMIT_PROVIDER_EVALUATION_ROWS,
  buildModelEvaluationEvidence,
  discoverPendingEvaluationCandidates,
} from './implementer-provider.js';
import { buildEvalConfig } from './eval-config.js';
import {
  aggregateComparisons,
  collectRunMetrics,
  compareScenario,
  type EvalReport,
  type RunMetrics,
  type ScenarioComparison,
} from './metrics.js';
import { formatCliSummary, generateReport } from './report.js';
import { copyScenarioFixture, preserveSessionArtifacts, runInEvalSandbox } from './runner.js';

import type { Summary } from '../src/core/schemas/summary.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import { taskId } from '../src/core/schemas/task.js';

import { breakdownEntry, makeRunMetrics, makeSummary } from './eval-factories.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_EVALUATION_EVIDENCE_PATH = join(
  REPO_ROOT,
  'testing/fixtures/model-evaluation/model-evaluations.json',
);

describe('eval harness', () => {
  it('writes JSON and markdown reports to a chosen output directory', async () => {
    await withTempDir((dir) => {
      const report = makeReport(null);

      const { jsonPath, mdPath } = generateReport(report, dir);
      const json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(json.aggregate.scenariosRun).toBe(1);
      expect(json.aggregate.avgBaselineFirstPassRatePercent).toBe(0);
      expect(json.aggregate.avgRoutedFirstPassRatePercent).toBe(0);
      expect(json.aggregate.totalRetryAttempts).toBe(0);
      expect(json.aggregate.totalEscalations).toBe(0);
      expect(markdown).toContain('Fake scenario');
    });
  });

  it('leads the markdown summary with first-pass', async () => {
    await withTempDir((dir) => {
      const { mdPath } = generateReport(makeReport(null), dir);
      const markdown = readFileSync(mdPath, 'utf-8');
      const summarySection = markdown.slice(0, markdown.indexOf('## Per-scenario results'));
      const dataRows = summarySection
        .split('\n')
        .filter((line) => line.startsWith('|') && !line.startsWith('|---'))
        .slice(1);

      expect(dataRows[0]).toContain('First-pass (baseline)');
    });
  });

  it('rounds the aggregate first-pass delta to one decimal instead of publishing the raw subtraction', async () => {
    await withTempDir((dir) => {
      const scenario = compareScenario({
        scenarioId: 'fake',
        scenarioName: 'Fake scenario',
        baseline: makeRunMetrics({ mode: 'baseline', summary: firstPassOfThree(1) }),
        routed: makeRunMetrics({ mode: 'routed', summary: firstPassOfThree(2) }),
      });
      const report = makeReportOf([scenario]);
      const { mdPath } = generateReport(report, dir);
      const markdown = readFileSync(mdPath, 'utf-8');

      expect(report.aggregate.avgBaselineFirstPassRatePercent).toBe(33.3);
      expect(report.aggregate.avgRoutedFirstPassRatePercent).toBe(66.7);
      expect(markdown).toContain('| First-pass Δ (routed − baseline) | +33.4pp |');
    });
  });

  it('excludes unpriced runs from the aggregate totals instead of averaging in a fabricated zero', () => {});

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
      const baseline = collectRunMetrics({
        scenarioId: 'fake',
        mode: 'baseline',
        summary: makeSummary({
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
        events: [],
        qualityResults: [{ passed: true, detail: 'ok' }],
        durationMs: 100,
        sessionArtifactsDir: null,
      });
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

  it('prints first-pass rates first on the CLI and quality retention last', () => {
    const lines = formatCliSummary(makeReport(null));
    expect(lines[0]).toBe('First-pass (baseline): 0%');
    expect(lines[lines.length - 1]).toContain('Avg quality retention');
  });

  it('prints the review line third on the CLI, after the first-pass rows', () => {
    const lines = formatCliSummary(makeReport(null));
    expect(lines[2]).toContain('Review yield:');
    expect(lines[2]).toContain('planner: planner-model');
    expect(lines[2]).toContain('routed implementer: routed-model');
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
      const metrics = collectRunMetrics({
        scenarioId: 'fake',
        mode: 'baseline',
        summary: makeSummary(),
        events: retryEvents,
        qualityResults: [{ passed: true, detail: 'ok' }],
        durationMs: 100,
        sessionArtifactsDir: null,
      });

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

  it('discovers pending-evaluation candidates for Ollama and LM Studio', () => {
    expect(discoverPendingEvaluationCandidates()).toEqual([
      { provider: 'ollama', model: 'qwen3-coder:30b' },
      { provider: 'lm-studio', model: 'qwen2.5-coder-7b' },
    ]);
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
    expect(config.planner.provider).toBe('custom-endpoint');
    expect(config.planner.service).toBe('custom-endpoint');
    expect(config.planner.offering).toBe('payg');
    expect(config.implementer.service).toBe('custom-endpoint');
    expect(config.implementer.offering).toBe('payg');
    expect(config.planner.apiBase).toBe('https://api.example.test/v1');
    expect(config.workflow.approve).toBe('none');
  });

  it('selects the baseline implementer model in baseline mode and the routed model in routed mode', () => {
    const pair = makeModelPair();

    expect(buildEvalConfig(pair, 'baseline').implementer.model).toBe('baseline-model');
    expect(buildEvalConfig(pair, 'routed').implementer.model).toBe('routed-model');
  });

  it('rejects a catalog provider only one eval role admits, instead of failing schema parsing', () => {
    for (const provider of ['ollama', 'lm-studio']) {
      const pair = { ...makeModelPair(), provider };

      expect(() => buildEvalConfig(pair, 'baseline')).toThrow(
        expect.objectContaining({ kind: 'eval-provider-not-usable-for-both-roles' }),
      );
      expect(() => buildEvalConfig(pair, 'baseline')).toThrow(
        new RegExp(`"${provider}".*not usable for both eval roles`),
      );
    }
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

function makeModelPair() {
  return {
    plannerModel: 'planner-model',
    baselineImplementerModel: 'baseline-model',
    routedImplementerModel: 'routed-model',
    provider: 'custom-endpoint',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'secret',
  };
}

function harnessSourceFiles(): string[] {
  return readdirSync(join(REPO_ROOT, 'evals'), { recursive: true, encoding: 'utf-8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .filter((entry) => !entry.startsWith('fixtures/'))
    .map((entry) => join('evals', entry));
}

function writeSessionArtifacts(projectDir: string, sessionId: string): void {
  const sessionDirectory = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, 'review.md'), '# review');
  writeFileSync(join(sessionDirectory, 'session.jsonl'), '{"type":"escalate"}\n');
}

function firstPassOfThree(firstPassTasks: number): Partial<Summary> {
  return {
    totalTasks: 3,
    taskBreakdown: [0, 1, 2].map((index) =>
      breakdownEntry(`T00${index + 1}`, 'local', index < firstPassTasks ? 0 : 1),
    ),
  };
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

function makeReport(sessionArtifactsDir: string | null, baseline?: RunMetrics): EvalReport {
  const baselineMetrics = baseline ?? makeRunMetrics({ mode: 'baseline', sessionArtifactsDir });
  const routed = makeRunMetrics({ mode: 'routed' });
  return makeReportOf([
    compareScenario({
      scenarioId: 'fake',
      scenarioName: 'Fake scenario',
      baseline: baselineMetrics,
      routed,
    }),
  ]);
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'splitbrief-eval-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
