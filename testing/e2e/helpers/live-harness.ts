import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import YAML from 'yaml';
import { evaluateTsArtifact } from './artifact-assertions.js';
import { blockerLines } from './blockers.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { prepareExecution } from '../../../src/engine/runners/prepare-execution/prepare-execution.js';
import { releasePreparedSession } from '../../../src/core/sessions/prepare.js';
import { CLI_TOOL_IDS } from '../../../src/core/runners/cli-tool-catalog.js';
import { detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { parseOpenCodeNativeModelCatalog } from '../../../src/engine/providers/cli-model-catalog.js';
import { includes } from '../../../src/utils/type-guards.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

type LiveScenario = Readonly<{
  tool: string;
  model: string | undefined;
  mode: 'quick' | 'standard';
  feature: string;
  /** Written to <project>/validate.mjs; run as the validation command. */
  validateScript: string;
  implementerContextLength: number;
  maxRetries: number;
  tempPrefix: string;
}>;

/** Everything a tier fixes for every tool that runs it; the scenario adds the tool, pin and prefix. */
type LiveTier = Omit<LiveScenario, 'tool' | 'model' | 'tempPrefix'>;

type LiveRunResult = Readonly<{ summary: Summary; projectDir: string }>;

const REFUSED_MODEL_TOKENS: readonly string[] = ['opus', 'fable', 'sol'];

/** Per-pair spend ceiling documented in docs/TESTING.md, by the mode each tier runs. */
const MAX_BUDGET_USD: Readonly<Record<LiveScenario['mode'], number>> = {
  quick: 0.05,
  standard: 0.5,
};

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
  const [detection] = await detectAvailableCliTools({ tools: [tool], projectDir: process.cwd() });
  if (detection === undefined) return `${tool} produced no detection record`;
  if (detection.diagnostic.state !== 'ready') {
    return `${tool} is not ready (${detection.diagnostic.state})`;
  }
  return null;
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
    stdout = execFileSync('opencode', ['models'], { encoding: 'utf-8', timeout: 60_000 });
  } catch {
    return undefined;
  }
  const catalog = parseOpenCodeNativeModelCatalog(stdout);
  if (catalog === null) return undefined;
  return catalog.models.find((entry) => entry.selectionId.toLowerCase().includes('free'))
    ?.selectionId;
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
        typecheck: false,
        lint: false,
        test: true,
        testCommand: 'node validate.mjs',
      },
      workflow: {
        mode: scenario.mode,
        approve: 'none',
        maxRetries: scenario.maxRetries,
        maxBudget: MAX_BUDGET_USD[scenario.mode],
        persistTranscript: true,
      },
    });
    mkdirSync(join(projectDir, '.splitbrief'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief/config.yaml'), YAML.stringify(config), 'utf-8');

    if (!bannerPrinted) {
      bannerPrinted = true;
      console.log('LIVE run: real CLI calls — real tokens will be billed.');
    }

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

    const summary = await runWorkflow({
      prepared: preparation.execution,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
    });

    assertions({ summary, projectDir });
  } finally {
    cleanupTempDir(projectDir);
  }
}

export const EASY_TIER: LiveTier = {
  mode: 'quick',
  feature:
    'Create src/live-easy.ts exporting a string constant named liveEasy with value "live-easy".',
  validateScript:
    [
      "const { liveEasy } = await import('./src/live-easy.ts');",
      "if (liveEasy !== 'live-easy') process.exit(1);",
    ].join('\n') + '\n',
  implementerContextLength: 4096,
  maxRetries: 1,
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
  mode: 'standard',
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
  maxRetries: 1,
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
