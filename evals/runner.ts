import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sessionDir } from '../src/core/paths.js';
import type { Config } from '../src/core/schemas/config.js';
import { createEventBus } from '../src/engine/events/bus.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import { runWorkflow } from '../src/engine/orchestrator/run/workflow.js';
import type { ModelCacheAccessor } from '../src/engine/providers/model/resolution.js';
import {
  loadModelsDevCatalogCache,
  type ModelsDevCatalogSnapshot,
} from '../src/engine/providers/models-dev-cache.js';
import { prepareExecution } from '../src/engine/runners/prepare-execution/prepare-execution.js';
import { releasePreparedSession } from '../src/core/sessions/prepare.js';
import { createCassetteRecorder } from '#testing/helpers/cassette/recorder.js';
import { createCassetteReplayer, loadCassette } from '#testing/helpers/cassette/replayer.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { buildEvalConfig, type EvalMode, type ModelPair } from './eval-config.js';
import {
  aggregateComparisons,
  collectRunMetrics,
  compareScenario,
  type EvalReport,
  type RunMetrics,
} from './metrics.js';
import { generateReport } from './report.js';
import { ensureNodeModules } from './scenarios/ensure-node-modules.js';
import type { EvalScenario, QualityCheckResult } from './scenarios/types.js';

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
  const tmpDir = mkdtempSync(join(tmpdir(), `splitbrief-eval-${scenario.id}-${mode}-`));
  const projectDir = join(tmpDir, basename(scenario.fixtureDir));
  cpSync(scenario.fixtureDir, projectDir, { recursive: true });
  ensureNodeModules(projectDir);
  return { tmpDir, projectDir };
}

export function preserveSessionArtifacts(input: {
  projectDir: string;
  sessionId: string;
  outputDir: string;
  scenarioId: string;
  mode: EvalMode;
}): string | null {
  const sessionDirectory = sessionDir(input.projectDir, input.sessionId);
  if (!existsSync(sessionDirectory)) return null;
  const targetDir = join(input.outputDir, 'sessions', input.scenarioId, input.mode);
  mkdirSync(targetDir, { recursive: true });
  cpSync(sessionDirectory, targetDir, { recursive: true });
  return targetDir;
}

export type EvalSandbox = {
  tmpDir: string;
  projectDir: string;
  outputDir: string;
  scenarioId: string;
  mode: EvalMode;
};

/**
 * Runs one scenario against a throwaway project copy and preserves its session
 * directory before the copy is deleted, so a run that threw leaves the artifacts
 * that explain why. A preservation failure only warns: it must never replace the
 * error the run was already raising.
 */
export async function runInEvalSandbox<T>(
  sandbox: EvalSandbox,
  run: (adoptSession: (sessionId: string) => void) => Promise<T>,
): Promise<{ value: T; sessionArtifactsDir: string | null }> {
  const { tmpDir, projectDir, outputDir, scenarioId, mode } = sandbox;
  let sessionId: string | null = null;
  let sessionArtifactsDir: string | null = null;
  let value: T;
  try {
    value = await run((id) => {
      sessionId = id;
    });
  } finally {
    if (sessionId !== null) {
      try {
        sessionArtifactsDir = preserveSessionArtifacts({
          projectDir,
          sessionId,
          outputDir,
          scenarioId,
          mode,
        });
      } catch (cause) {
        console.warn(
          `could not preserve session artifacts for ${scenarioId}/${mode}: ${String(cause)}`,
        );
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return { value, sessionArtifactsDir };
}

async function runSingleEval(
  scenario: EvalScenario,
  config: Config,
  mode: EvalMode,
  opts: { record: boolean; replay: boolean; cassetteDir: string; outputDir: string },
  modelCache: ModelCacheAccessor | null,
): Promise<RunMetrics> {
  const { tmpDir, projectDir } = copyScenarioFixture(scenario, mode);
  createTestGitRepo(projectDir);
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));

  const cassetteFile = join(opts.cassetteDir, `${scenario.id}-${mode}.json`);

  const { value: completed, sessionArtifactsDir } = await runInEvalSandbox(
    { tmpDir, projectDir, outputDir: opts.outputDir, scenarioId: scenario.id, mode },
    async (adoptSession) => {
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
              config.implementer.kind === 'api'
                ? (config.implementer.model ?? 'unknown')
                : 'unknown',
          });
          recorder.install();
        }
        if (opts.replay) {
          const cassette = loadCassette(cassetteFile);
          replayer = createCassetteReplayer(cassette);
          replayer.install();
        }

        const startMs = Date.now();
        const preparation = await prepareExecution({
          projectDir,
          feature: scenario.feature,
          effectiveConfig: config,
          policy: {
            purpose: 'new-workflow',
            interaction: 'headless',
            unverifiedAuth: 'allowed',
            allowRepoRunners: false,
            allowHooks: false,
          },
          signal: new AbortController().signal,
        });
        if (preparation.kind === 'failed') throw preparation.error;
        if (preparation.kind !== 'prepared') {
          throw new Error(`Eval runner preparation ended with '${preparation.kind}'.`);
        }
        adoptSession(preparation.execution.session.ref.sessionId);
        if (preparation.execution.session.kind === 'new') {
          releasePreparedSession({
            ref: preparation.execution.session.ref,
            ownership: preparation.execution.session.ownership,
          });
        }
        const summary = await runWorkflow({
          prepared: preparation.execution,
          headless: true,
          eventBus: bus,
          modelCache: modelCache ?? undefined,
          sinks: { setAbortHandler: () => undefined, setQueueHandler: () => undefined },
          callbacks: {
            onApprovalNeeded: async () => ({ approved: true }),
            onQuestionAsked: async () => '',
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

        return { summary, durationMs, qualityResults };
      } finally {
        if (recorder) {
          recorder.save();
          recorder.uninstall();
        }
        if (replayer) replayer.uninstall();
      }
    },
  );

  return collectRunMetrics({
    scenarioId: scenario.id,
    mode,
    summary: completed.summary,
    events,
    qualityResults: completed.qualityResults,
    durationMs: completed.durationMs,
    sessionArtifactsDir,
  });
}

/**
 * Pricing for a run comes from the snapshot the run loaded. Hydrating the app's
 * model-cache store instead would put every scenario of the process behind one
 * global catalog, which only ever accepts the first snapshot hydrated into it.
 */
export function createEvalModelCache(snapshot: ModelsDevCatalogSnapshot): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => snapshot.catalog,
    getProviderModels: () => null,
  };
}

async function loadEvalPricingCache(): Promise<ModelCacheAccessor | null> {
  let snapshot: ModelsDevCatalogSnapshot | null;
  try {
    snapshot = await loadModelsDevCatalogCache();
  } catch {
    snapshot = null;
  }
  if (snapshot === null) {
    console.log(
      'pricing unavailable: no cached models.dev catalog snapshot — costs will read unpriced',
    );
    return null;
  }
  return createEvalModelCache(snapshot);
}

export async function runEvalSuite(opts: EvalRunOptions): Promise<EvalReport> {
  if (opts.record && opts.replay) {
    throw new Error('Use either record or replay mode, not both');
  }

  const modelCache = await loadEvalPricingCache();
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
    const baseline = await runSingleEval(scenario, baselineConfig, 'baseline', opts, modelCache);
    console.log(formatRunProgressLine(baseline));

    console.log(`  routed (${opts.routedImplementerModel})...`);
    const routedConfig = buildEvalConfig(modelPair, 'routed');
    const routed = await runSingleEval(scenario, routedConfig, 'routed', opts, modelCache);
    console.log(formatRunProgressLine(routed));

    comparisons.push(
      compareScenario({ scenarioId: scenario.id, scenarioName: scenario.name, baseline, routed }),
    );
  }

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    plannerModel: opts.plannerModel,
    baselineImplementerModel: opts.baselineImplementerModel,
    routedImplementerModel: opts.routedImplementerModel,
    scenarios: comparisons,
    aggregate: aggregateComparisons(comparisons),
  };

  const { jsonPath, mdPath } = generateReport(report, opts.outputDir);
  console.log(`\nReport written to ${jsonPath}`);
  console.log(`Markdown written to ${mdPath}`);

  return report;
}

export function formatRunProgressLine(run: RunMetrics): string {
  const cost = run.cost.pricingAvailable ? `$${run.cost.estimatedCostUSD.toFixed(4)}` : 'unpriced';
  return `    cost: ${cost} | quality: ${Math.round(run.quality.score * 100)}%`;
}
