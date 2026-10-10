import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import YAML from 'yaml';
import { evaluateTsArtifact } from './artifact-assertions.js';
import { blockerLines } from './blockers.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import type { OrchestratorCallbacks } from '../../../src/engine/orchestrator/types.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import { releasePreparedSession } from '../../../src/core/sessions/prepare.js';
import {
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  REVIEW_FILE,
  SESSION_LOG_FILE,
  SUMMARY_FILE,
  TASKS_FILE,
} from '../../../src/core/paths.js';
import {
  CLI_TOOL_IDS,
  type CliToolId,
  defaultCliAuthChannel,
} from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { parseOpenCodeNativeModelCatalog } from '../../../src/engine/providers/cli-model-catalog.js';
import { includes } from '../../../src/utils/type-guards.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import type { Config } from '../../../src/core/schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

/** What a tier tests: a one-file brief, a brief over two files, or a planner question round. */
export type LiveMatrixTierId = 'one-file' | 'two-files' | 'question-round';

type LiveScenario = Readonly<{
  tool: string;
  model: string | undefined;
  feature: string;
  /** Written to <project>/validate.mjs; run as the validation command. */
  validateScript: string;
  implementerContextLength: number;
  tempPrefix: string;
}>;

/** Everything a tier fixes for every tool that runs it; the scenario adds the tool, pin and prefix. */
type LiveTier = Omit<LiveScenario, 'tool' | 'model' | 'tempPrefix'>;

type LiveRunResult = Readonly<{ summary: Summary; projectDir: string }>;

const REFUSED_MODEL_TOKENS: readonly string[] = ['opus', 'fable', 'sol'];

let bannerPrinted = false;

function assertModelUnderCostCeiling(tool: string, model: string): void {
  for (const token of model.toLowerCase().split(/[^a-z0-9]+/)) {
    if (REFUSED_MODEL_TOKENS.includes(token)) {
      throw new Error(
        `Live model pin '${model}' for ${tool} is above the live e2e cost ceiling ('${token}').`,
      );
    }
  }
}

export function liveTierEnabled(tier: 'easy' | 'heavy'): boolean {
  if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1') return false;
  const selected = process.env.SPLITBRIEF_REAL_CLI_TIER ?? 'easy';
  return selected === 'all' || selected === tier;
}

export async function liveToolBlocker(tool: string): Promise<string | null> {
  if (!includes(CLI_TOOL_IDS, tool)) return `${tool} is not in the CLI tool catalog`;
  const [detection] = await detectAvailableCliTools({
    tools: [tool],
    projectDir: process.cwd(),
    authChannels: { [tool]: defaultCliAuthChannel(tool).id },
  });
  if (detection === undefined) return `${tool} produced no detection record`;
  if (detection.diagnostic.state !== 'ready') {
    return `${tool} is not ready (${detection.diagnostic.state})`;
  }
  return null;
}

export type LiveRowGate = Readonly<{ kind: 'run' }> | Readonly<{ kind: 'skip'; reason: string }>;

export function liveSkipAllowList(env: string | undefined): ReadonlySet<string> {
  return new Set(
    (env ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );
}

export function liveRowGateDecision(opts: {
  readiness: readonly Readonly<{ tool: string; state: string }>[];
  allowList: ReadonlySet<string>;
}): LiveRowGate {
  const notReady = opts.readiness.find((entry) => entry.state !== 'ready');
  if (notReady === undefined) return { kind: 'run' };
  if (opts.allowList.has(notReady.tool)) {
    return {
      kind: 'skip',
      reason: `${notReady.tool} is not ready (${notReady.state}); listed in SPLITBRIEF_LIVE_SKIP`,
    };
  }
  throw new Error(
    `${notReady.tool} is not ready (${notReady.state}) and is not in SPLITBRIEF_LIVE_SKIP; release rows fail on unlisted missing tools`,
  );
}

export async function gateLiveMatrixRow(tools: readonly string[]): Promise<LiveRowGate> {
  const catalogTools = tools.map((tool) => {
    if (!includes(CLI_TOOL_IDS, tool)) {
      throw new Error(`${tool} is not in the CLI tool catalog`);
    }
    return tool;
  });
  const records = await detectAvailableCliTools({
    tools: catalogTools,
    projectDir: process.cwd(),
    authChannels: Object.fromEntries(
      catalogTools.map((tool) => [tool, defaultCliAuthChannel(tool).id]),
    ),
  });
  const readiness = catalogTools.map((tool, index) => {
    const record = records[index];
    if (record === undefined) return { tool, state: 'no detection record' };
    return { tool: record.tool, state: record.diagnostic.state };
  });
  return liveRowGateDecision({
    readiness,
    allowList: liveSkipAllowList(process.env.SPLITBRIEF_LIVE_SKIP),
  });
}

export function liveModelPin(opts: {
  tool: string;
  fallback: string | undefined;
}): string | undefined {
  const { tool, fallback } = opts;
  const envName = `SPLITBRIEF_REAL_CLI_${tool.toUpperCase().replaceAll('-', '_')}_MODEL`;
  const model = process.env[envName] ?? fallback;
  if (model === undefined) return undefined;
  assertModelUnderCostCeiling(tool, model);
  return model;
}

export function openCodeFreeModelId(): string | undefined {
  let stdout: string;
  try {
    stdout = execFileSync('opencode', ['api', 'GET', '/api/model'], {
      encoding: 'utf-8',
      timeout: 60_000,
    });
  } catch {
    return undefined;
  }
  const catalog = parseOpenCodeNativeModelCatalog(stdout);
  if (catalog === null) return undefined;
  return catalog.models.find((entry) => entry.selectionId.toLowerCase().includes('free'))
    ?.selectionId;
}

async function executeLiveWorkflow(opts: {
  projectDir: string;
  feature: string;
  effectiveConfig: Config;
  onPlannerReply?: NonNullable<OrchestratorCallbacks['onPlannerReply']>;
}): Promise<{ summary: Summary; sessionId: string }> {
  const preparation = await prepareExecution({
    projectDir: opts.projectDir,
    feature: opts.feature,
    effectiveConfig: opts.effectiveConfig,
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
  if (preparation.kind === 'blocked') {
    throw new Error(
      `Live CLI preparation was blocked:\n${blockerLines(preparation.report).join('\n')}`,
    );
  }
  if (preparation.kind !== 'prepared') {
    throw new Error(`Live CLI preparation ended with '${preparation.kind}'.`);
  }
  if (preparation.execution.session.kind === 'new') {
    releasePreparedSession({
      ref: preparation.execution.session.ref,
      ownership: preparation.execution.session.ownership,
    });
  }
  const sessionId = preparation.execution.session.ref.sessionId;
  const summary = await runWorkflow({
    prepared: preparation.execution,
    callbacks: makeCallbacks(
      opts.onPlannerReply === undefined ? {} : { onPlannerReply: opts.onPlannerReply },
    ).callbacks,
    sinks: TEST_WORKFLOW_SINKS,
  });
  return { summary, sessionId };
}

export async function runLiveScenario(
  scenario: LiveScenario,
  assertions: (result: LiveRunResult) => void,
): Promise<void> {
  if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1') {
    throw new Error('Live scenario invoked without SPLITBRIEF_REAL_CLI_E2E=1.');
  }
  const tool = scenario.tool;
  if (!includes(CLI_TOOL_IDS, tool)) {
    throw new Error(`${tool} is not in the CLI tool catalog.`);
  }
  const model = scenario.model;
  if (model === undefined) {
    throw new Error(
      `Live scenario for ${tool} carries no model pin; a real call would run on the account default.`,
    );
  }
  assertModelUnderCostCeiling(tool, model);
  resetAllStores();
  const projectDir = createTempDir(scenario.tempPrefix);
  try {
    createTestGitRepo(projectDir);
    writeFileSync(join(projectDir, 'validate.mjs'), scenario.validateScript, 'utf-8');

    const config = makeConfig({
      planner: { kind: 'cli', tool, model },
      implementer: {
        kind: 'cli',
        tool,
        model,
        contextLength: scenario.implementerContextLength,
      },
      validation: {
        endChecks: true,
        testCommand: 'node validate.mjs',
      },
      workflow: {
        approve: 'none',
      },
    });
    mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief/config.yaml'), YAML.stringify(config), 'utf-8');

    if (!bannerPrinted) {
      bannerPrinted = true;
      console.log('LIVE run: real CLI calls — real tokens will be billed.');
    }

    const { summary } = await executeLiveWorkflow({
      projectDir,
      feature: scenario.feature,
      effectiveConfig: config,
    });

    assertions({ summary, projectDir });
  } finally {
    cleanupTempDir(projectDir);
  }
}

export const EASY_TIER: LiveTier = {
  feature:
    'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  validateScript:
    [
      "const { liveEasy } = await import('./src/live-easy.ts');",
      "if (liveEasy !== 'live-easy') process.exit(1);",
    ].join('\n') + '\n',
  implementerContextLength: 4096,
};

export function easyAssertions({ summary, projectDir }: LiveRunResult): void {
  expect(summary.failed).toBe(0);
  expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  expect(summary.tokenUsage.implementerInput).toBeGreaterThan(0);
  expect(evaluateTsArtifact(join(projectDir, 'src/live-easy.ts'), 'mod.liveEasy')).toBe(
    'live-easy',
  );
  expect(existsSync(join(projectDir, '.splitbrief'))).toBe(true);
}

export const HEAVY_TIER: LiveTier = {
  feature:
    'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
  validateScript:
    [
      "const { liveHeavyValue } = await import('./src/live-heavy/value.ts');",
      "const { doubleLiveHeavy } = await import('./src/live-heavy/double.ts');",
      'if (liveHeavyValue !== 42) process.exit(1);',
      'if (doubleLiveHeavy(21) !== 42) process.exit(1);',
    ].join('\n') + '\n',
  implementerContextLength: 128_000,
};

export function heavyAssertions({ summary }: LiveRunResult): void {
  expect(summary.failed).toBe(0);
  expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  expect(summary.tokenUsage.plannerInput).toBeGreaterThan(0);
  expect(summary.tokenUsage.implementerInput).toBeGreaterThan(0);
  expect(summary.reviewPacket).toBeDefined();
  expect(typeof summary.reviewPacket?.finalReviewStatus).toBe('string');
  expect(summary.evidenceSummary).toBeDefined();
  for (const task of summary.taskBreakdown ?? []) {
    expect(task.retryCount).toBeLessThanOrEqual(1);
  }
}

export type LiveSeat = Readonly<{ tool: string; model: string | undefined }>;

export type ReleaseMatrixRun = Readonly<{
  id: string;
  tier: LiveMatrixTierId;
  task: string;
  plan: LiveSeat;
  build: LiveSeat;
  review?: LiveSeat | undefined;
}>;

export type LiveMatrixTier = Readonly<{
  task: string;
  validateScript: string;
  implementerContextLength: number;
  artifact: Readonly<{ path: string; accessor: string; expected: string | number }>;
  /** The answer to a question the planner asks before it plans. */
  plannerAnswer?: string | undefined;
}>;

export const MATRIX_TIERS: Readonly<Record<LiveMatrixTierId, LiveMatrixTier>> = {
  'one-file': {
    task: 'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
    validateScript:
      [
        "const { liveEasy } = await import('./src/live-easy.ts');",
        "if (liveEasy !== 'live-easy') process.exit(1);",
      ].join('\n') + '\n',
    implementerContextLength: 4096,
    artifact: { path: 'src/live-easy.ts', accessor: 'mod.liveEasy', expected: 'live-easy' },
  },
  'two-files': {
    task: 'Add src/live-heavy/value.ts exporting a number constant liveHeavyValue with value 42, and src/live-heavy/double.ts exporting a function doubleLiveHeavy that returns its numeric argument times two.',
    validateScript:
      [
        "const { liveHeavyValue } = await import('./src/live-heavy/value.ts');",
        "const { doubleLiveHeavy } = await import('./src/live-heavy/double.ts');",
        'if (liveHeavyValue !== 42) process.exit(1);',
        'if (doubleLiveHeavy(21) !== 42) process.exit(1);',
      ].join('\n') + '\n',
    implementerContextLength: 128_000,
    artifact: { path: 'src/live-heavy/value.ts', accessor: 'mod.liveHeavyValue', expected: 42 },
  },
  'question-round': {
    task: 'Create src/live-question.ts exporting a string constant named liveQuestion with value "live-question".',
    validateScript:
      "const { liveQuestion } = await import('./src/live-question.ts');\nif (liveQuestion !== 'live-question') process.exit(1);\n",
    implementerContextLength: 128_000,
    artifact: {
      path: 'src/live-question.ts',
      accessor: 'mod.liveQuestion',
      expected: 'live-question',
    },
    plannerAnswer:
      "The deliverable is a single file, src/live-question.ts, with a named string export liveQuestion whose value is exactly 'live-question'. No default export, no extra files, no config changes.",
  },
};

const DEFAULT_LIVE_ARTIFACT_ROOT = '.test-artifacts/live';

function liveManifestPath(root: string): string {
  return join(root, 'manifest.json');
}

export function beginLiveManifest(root: string = DEFAULT_LIVE_ARTIFACT_ROOT): string {
  mkdirSync(root, { recursive: true });
  const manifestPath = liveManifestPath(root);
  writeFileSync(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), rows: [] }, null, 2) + '\n',
    'utf-8',
  );
  return manifestPath;
}

export type LiveArtifactPaths = Readonly<{
  summary: string | null;
  sessionLog: string | null;
  tasks: string | null;
  evidence: string | null;
  driftReport: string | null;
  review: string | null;
}>;

export type LiveManifestRow = Readonly<{
  id: string;
  /** Absent on a fixture-loop row, which runs a fixture project instead of a tier task. */
  tier?: LiveMatrixTierId | undefined;
  plan: LiveSeat;
  build: LiveSeat;
  review?: LiveSeat | null;
  outcome: 'pass' | 'fail' | 'skip';
  reason?: string | undefined;
  totalTasks?: number | undefined;
  failedTasks?: number | undefined;
  plannerInputTokens?: number | undefined;
  implementerInputTokens?: number | undefined;
  /** Model calls per seat, so a run measures calls-per-feature across brief-granularity changes. */
  calls?: Readonly<{ planner: number; implementer: number; review: number }> | undefined;
  briefs?: readonly Readonly<{ id: string; durationMs: number }>[] | undefined;
  durationMs: number;
  artifacts?: LiveArtifactPaths | undefined;
}>;

export function appendLiveManifestRow(
  row: LiveManifestRow,
  root: string = DEFAULT_LIVE_ARTIFACT_ROOT,
): void {
  mkdirSync(root, { recursive: true });
  const manifestPath = liveManifestPath(root);
  let manifest: { generatedAt: string; rows: LiveManifestRow[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    manifest = { generatedAt: new Date().toISOString(), rows: [] };
  }
  manifest.rows.push(row);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function copyArtifact(sessionDir: string, rowDir: string, file: string): string | null {
  const source = join(sessionDir, file);
  if (!existsSync(source)) return null;
  const target = join(rowDir, file);
  copyFileSync(source, target);
  return target;
}

export function copyLiveArtifacts(opts: {
  projectDir: string;
  sessionId: string;
  rowId: string;
  root?: string;
}): LiveArtifactPaths {
  const rowDir = join(opts.root ?? DEFAULT_LIVE_ARTIFACT_ROOT, opts.rowId);
  mkdirSync(rowDir, { recursive: true });
  const sessionDir = join(opts.projectDir, '.splitbrief', 'sessions', opts.sessionId);
  return {
    summary: copyArtifact(sessionDir, rowDir, SUMMARY_FILE),
    sessionLog: copyArtifact(sessionDir, rowDir, SESSION_LOG_FILE),
    tasks: copyArtifact(sessionDir, rowDir, TASKS_FILE),
    evidence: copyArtifact(sessionDir, rowDir, EVIDENCE_FILE),
    driftReport: copyArtifact(sessionDir, rowDir, DRIFT_REPORT_FILE),
    review: copyArtifact(sessionDir, rowDir, REVIEW_FILE),
  };
}

export function catalogTool(tool: string): CliToolId {
  if (!includes(CLI_TOOL_IDS, tool)) {
    throw new Error(`${tool} is not in the CLI tool catalog.`);
  }
  return tool;
}

export function releaseMatrixConfig(run: ReleaseMatrixRun, tier: LiveMatrixTier): Config {
  return makeConfig({
    planner: { kind: 'cli', tool: catalogTool(run.plan.tool), model: run.plan.model },
    implementer: {
      kind: 'cli',
      tool: catalogTool(run.build.tool),
      model: run.build.model,
      contextLength: tier.implementerContextLength,
    },
    ...(run.review === undefined
      ? {}
      : { reviewer: { kind: 'cli', tool: catalogTool(run.review.tool), model: run.review.model } }),
    validation: {
      endChecks: true,
      testCommand: 'node validate.mjs',
    },
    workflow: {
      approve: 'none',
    },
  });
}

export function releaseMatrixAssertions(
  tier: LiveMatrixTierId,
  { summary, projectDir }: LiveRunResult,
): void {
  const artifact = MATRIX_TIERS[tier].artifact;
  expect(summary.failed).toBe(0);
  expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  expect(summary.tokenUsage.implementerInput).toBeGreaterThan(0);
  expect(evaluateTsArtifact(join(projectDir, artifact.path), artifact.accessor)).toBe(
    artifact.expected,
  );
  expect(summary.tokenUsage.plannerInput).toBeGreaterThan(0);
  expect(summary.reviewPacket).toBeDefined();
  expect(typeof summary.reviewPacket?.finalReviewStatus).toBe('string');
  for (const task of summary.taskBreakdown ?? []) {
    expect(task.retryCount).toBeLessThanOrEqual(1);
  }
}

export type ReleaseMatrixRowResult = Readonly<{ outcome: 'pass' | 'skip'; reason?: string }>;

export async function runReleaseMatrixRow(run: ReleaseMatrixRun): Promise<ReleaseMatrixRowResult> {
  if (process.env.SPLITBRIEF_REAL_CLI_E2E !== '1') {
    throw new Error('Live scenario invoked without SPLITBRIEF_REAL_CLI_E2E=1.');
  }
  const startedAt = Date.now();
  const tier = MATRIX_TIERS[run.tier];
  const { plannerAnswer } = tier;
  const baseRowFields = {
    id: run.id,
    tier: run.tier,
    plan: run.plan,
    build: run.build,
    review: run.review ?? null,
    durationMs: Date.now() - startedAt,
  };
  let gate: LiveRowGate;
  try {
    gate = await gateLiveMatrixRow([
      run.plan.tool,
      run.build.tool,
      ...(run.review === undefined ? [] : [run.review.tool]),
    ]);
  } catch (error) {
    appendLiveManifestRow({
      ...baseRowFields,
      durationMs: Date.now() - startedAt,
      outcome: 'fail',
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (gate.kind === 'skip') {
    appendLiveManifestRow({
      ...baseRowFields,
      durationMs: Date.now() - startedAt,
      outcome: 'skip',
      reason: gate.reason,
    });
    return { outcome: 'skip', reason: gate.reason };
  }
  for (const seat of [run.plan, run.build, ...(run.review === undefined ? [] : [run.review])]) {
    if (seat.model === undefined) {
      const reason = `${seat.tool} carries no model pin; a real call would run on the account default.`;
      appendLiveManifestRow({
        ...baseRowFields,
        durationMs: Date.now() - startedAt,
        outcome: 'fail',
        reason,
      });
      throw new Error(reason);
    }
  }
  resetAllStores();
  const projectDir = createTempDir(`live-release-${run.id}`);
  try {
    createTestGitRepo(projectDir);
    writeFileSync(join(projectDir, 'validate.mjs'), tier.validateScript, 'utf-8');
    const config = releaseMatrixConfig(run, tier);
    mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief/config.yaml'), YAML.stringify(config), 'utf-8');

    if (!bannerPrinted) {
      bannerPrinted = true;
      console.log('LIVE run: real CLI calls — real tokens will be billed.');
    }

    const { summary, sessionId } = await executeLiveWorkflow({
      projectDir,
      feature: run.task,
      effectiveConfig: config,
      ...(plannerAnswer !== undefined && { onPlannerReply: async () => plannerAnswer }),
    });
    releaseMatrixAssertions(run.tier, { summary, projectDir });
    const artifacts = copyLiveArtifacts({ projectDir, sessionId, rowId: run.id });
    appendLiveManifestRow({
      ...baseRowFields,
      durationMs: Date.now() - startedAt,
      outcome: 'pass',
      totalTasks: summary.totalTasks,
      failedTasks: summary.failed,
      plannerInputTokens: summary.tokenUsage.plannerInput,
      implementerInputTokens: summary.tokenUsage.implementerInput,
      artifacts,
    });
    return { outcome: 'pass' };
  } catch (error) {
    appendLiveManifestRow({
      ...baseRowFields,
      durationMs: Date.now() - startedAt,
      outcome: 'fail',
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    cleanupTempDir(projectDir);
  }
}
