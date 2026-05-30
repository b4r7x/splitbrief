import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ConfigSchema, type Config } from '../src/core/schemas/config.js';
import { createEventBus } from '../src/engine/events/bus.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import { runWorkflow } from '../src/engine/orchestrator/run/run.js';
import { createCassetteRecorder } from '../testing/helpers/cassette/recorder.js';
import { createCassetteReplayer, loadCassette } from '../testing/helpers/cassette/replayer.js';
import { collectRunMetrics, compareScenario, type EvalReport, type RunMetrics } from './metrics.js';
import { generateReport } from './report.js';
import type { EvalScenario, QualityCheckResult } from './scenarios/types.js';

type EvalMode = 'baseline' | 'routed';

export type EvalRunOptions = {
  scenarios: EvalScenario[];
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  cassetteDir: string;
  outputDir: string;
  record: boolean;
  replay: boolean;
};

export type EvalProjectCopy = {
  tmpDir: string;
  projectDir: string;
};

export function copyScenarioFixture(
  scenario: Pick<EvalScenario, 'fixtureDir' | 'id'>,
  mode: EvalMode,
): EvalProjectCopy {
  const tmpDir = mkdtempSync(join(tmpdir(), `diptych-eval-${scenario.id}-${mode}-`));
  const projectDir = join(tmpDir, basename(scenario.fixtureDir));
  cpSync(scenario.fixtureDir, projectDir, { recursive: true });
  return { tmpDir, projectDir };
}

async function runSingleEval(
  scenario: EvalScenario,
  config: Config,
  mode: EvalMode,
  opts: { record: boolean; replay: boolean; cassetteDir: string },
): Promise<RunMetrics> {
  const { tmpDir, projectDir } = copyScenarioFixture(scenario, mode);
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));

  const cassetteFile = join(opts.cassetteDir, `${scenario.id}-${mode}.json`);
  let recorder: ReturnType<typeof createCassetteRecorder> | null = null;
  let replayer: ReturnType<typeof createCassetteReplayer> | null = null;

  try {
    if (opts.record) {
      recorder = createCassetteRecorder(cassetteFile, `${scenario.id}-${mode}`, {
        scenarioId: scenario.id,
        mode,
        plannerModel:
          config.planner.kind === 'api' ? (config.planner.model ?? 'unknown') : 'unknown',
        implementerModel:
          config.implementer.kind === 'api' ? (config.implementer.model ?? 'unknown') : 'unknown',
      });
      recorder.install();
    }
    if (opts.replay) {
      const cassette = loadCassette(cassetteFile);
      replayer = createCassetteReplayer(cassette);
      replayer.install();
    }

    const startMs = Date.now();
    const summary = await runWorkflow({
      feature: scenario.feature,
      projectDir,
      config,
      headless: true,
      eventBus: bus,
      sinks: { setAbortHandler: () => undefined, setQueueHandler: () => undefined },
      callbacks: {
        onApprovalNeeded: async () => ({ approved: true }),
        onQuestionAsked: async () => '',
        onBudgetExceeded: async () => true,
        onBudgetPaused: async () => 'continue',
        onContinuationNeeded: async () => '',
        onComplete: () => undefined,
      },
    });
    const durationMs = Date.now() - startMs;

    if (recorder) {
      recorder.save();
      recorder.uninstall();
      recorder = null;
    }
    if (replayer) {
      replayer.uninstall();
      replayer = null;
    }

    const qualityResults: QualityCheckResult[] = [];
    for (const check of scenario.qualityChecks) {
      qualityResults.push(await check.check(projectDir));
    }

    return collectRunMetrics(scenario.id, mode, summary, events, qualityResults, durationMs);
  } finally {
    try {
      if (recorder) {
        recorder.save();
        recorder.uninstall();
      }
      if (replayer) replayer.uninstall();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export async function runEvalSuite(opts: EvalRunOptions): Promise<EvalReport> {
  if (opts.record && opts.replay) {
    throw new Error('Use either record or replay mode, not both');
  }

  const comparisons: EvalReport['scenarios'] = [];
  const modelPair: ModelPair = {
    plannerModel: opts.plannerModel,
    baselineImplementerModel: opts.baselineImplementerModel,
    routedImplementerModel: opts.routedImplementerModel,
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
  };

  for (const scenario of opts.scenarios) {
    console.log(`\n--- ${scenario.name} ---`);

    console.log(`  baseline (${opts.baselineImplementerModel})...`);
    const baselineConfig = buildEvalConfig(modelPair, 'baseline');
    const baseline = await runSingleEval(scenario, baselineConfig, 'baseline', opts);
    console.log(
      `    cost: $${baseline.cost.estimatedCostUSD.toFixed(4)} | quality: ${Math.round(baseline.quality.score * 100)}%`,
    );

    console.log(`  routed (${opts.routedImplementerModel})...`);
    const routedConfig = buildEvalConfig(modelPair, 'routed');
    const routed = await runSingleEval(scenario, routedConfig, 'routed', opts);
    console.log(
      `    cost: $${routed.cost.estimatedCostUSD.toFixed(4)} | quality: ${Math.round(routed.quality.score * 100)}%`,
    );

    comparisons.push(compareScenario(scenario.id, scenario.name, baseline, routed));
  }

  const totalBaseline = comparisons.reduce(
    (sum, comparison) => sum + comparison.baselineCostUSD,
    0,
  );
  const totalRouted = comparisons.reduce((sum, comparison) => sum + comparison.routedCostUSD, 0);
  const avgSavings =
    comparisons.length > 0
      ? comparisons.reduce((sum, comparison) => sum + comparison.costSavingsPercent, 0) /
        comparisons.length
      : 0;
  const avgQuality =
    comparisons.length > 0
      ? comparisons.reduce((sum, comparison) => sum + comparison.qualityRetentionPercent, 0) /
        comparisons.length
      : 0;
  const matched = comparisons.filter(
    (comparison) => comparison.qualityRetentionPercent >= 100,
  ).length;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    plannerModel: opts.plannerModel,
    baselineImplementerModel: opts.baselineImplementerModel,
    routedImplementerModel: opts.routedImplementerModel,
    scenarios: comparisons,
    aggregate: {
      avgCostSavingsPercent: Math.round(avgSavings * 10) / 10,
      avgQualityRetentionPercent: Math.round(avgQuality * 10) / 10,
      totalBaselineCostUSD: totalBaseline,
      totalRoutedCostUSD: totalRouted,
      totalSavingsUSD: totalBaseline - totalRouted,
      scenariosRun: comparisons.length,
      scenariosWhereRoutedMatchedBaseline: matched,
    },
  };

  const { jsonPath, mdPath } = generateReport(report, opts.outputDir);
  console.log(`\nReport written to ${jsonPath}`);
  console.log(`Markdown written to ${mdPath}`);

  return report;
}

type ModelPair = {
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
};

export function buildEvalConfig(pair: ModelPair, mode: EvalMode): Config {
  const implementerModel =
    mode === 'baseline' ? pair.baselineImplementerModel : pair.routedImplementerModel;

  return ConfigSchema.parse({
    version: 3,
    planner: {
      kind: 'api',
      provider: pair.provider,
      apiBase: pair.baseUrl,
      model: pair.plannerModel,
      apiKey: pair.apiKey,
    },
    implementer: {
      kind: 'api',
      provider: pair.provider,
      apiBase: pair.baseUrl,
      model: implementerModel,
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
}
