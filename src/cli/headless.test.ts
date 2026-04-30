import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createInitialState } from '../core/state/machine.js';
import type { Config } from '../core/schemas/config.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';
import { beginSession } from '../core/sessions/lifecycle.js';

const runnerMocks = vi.hoisted(() => ({
  planner: undefined as Planner | undefined,
  implementer: undefined as Implementer | undefined,
}));

vi.mock('../engine/runners/factory.js', () => ({
  createPlanner: vi.fn(() => {
    if (!runnerMocks.planner) throw new Error('test planner not configured');
    return runnerMocks.planner;
  }),
  createImplementer: vi.fn(() => {
    if (!runnerMocks.implementer) throw new Error('test implementer not configured');
    return runnerMocks.implementer;
  }),
}));
vi.mock('../core/config/load/load.js');
vi.mock('../core/config/runtime/overrides.js');
vi.mock('../lib/warn.js', () => ({ warnStderr: vi.fn() }));

import { loadConfig } from '../core/config/load/load.js';
import { applyCLIOverrides } from '../core/config/runtime/overrides.js';
import { runHeadless } from './headless.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockApplyCLIOverrides = vi.mocked(applyCLIOverrides);

let dirs: string[] = [];

function makeExitError(code: number | string | null | undefined): Error & { code: number | string | null | undefined } {
  const err = new Error(`process.exit(${String(code)})`) as Error & { code: number | string | null | undefined };
  err.code = code;
  return err;
}

function makeBudgetConfig(pauseThreshold = 0.85): Config {
  return makeConfig({
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
    },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: {
      mode: 'quick',
      autoApproveSpec: true,
      autoApprovePlan: true,
      commitStrategy: 'none',
      persistTranscript: false,
      maxBudget: 20,
      budgetPauseThreshold: pauseThreshold,
    },
  });
}

function setupProject(): string {
  const projectDir = createTempDir('headless-budget-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  return projectDir;
}

function makeBudgetState(): WorkflowState {
  const task = makeTask({
    title: 'Do the task',
    action: 'modify',
    file: 'src/example.ts',
    description: 'Do the task',
    tests: ['verifies budget pause behavior with a passing validation command'],
    constraints: ['keep behavior focused on the budget threshold'],
    typeDefs: 'function runBudgetFixture(): void',
    implementationSteps: ['1. Run the implementation once', '2. Stop at the budget pause threshold'],
    scope: { inBounds: ['budget behavior'], outOfBounds: ['unrelated workflow changes'] },
    evidence: ['headless JSON output includes budget_paused'],
  });
  return {
    ...createInitialState('fix budget behavior'),
    phase: 'implementing',
    tasks: [task],
    plannerTool: 'anthropic',
    plannerModel: 'claude-sonnet-4-6',
    implementerTool: 'anthropic',
    implementerModel: 'claude-sonnet-4-6',
  };
}

describe('runHeadless — budget pause behavior', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number | string | null | undefined) => {
      throw makeExitError(code);
    }) as never);

    const config = makeBudgetConfig();
    mockLoadConfig.mockReturnValue({ config, warnings: [] });
    mockApplyCLIOverrides.mockReturnValue(config);
    runnerMocks.planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: '', usage: null }),
    });
    runnerMocks.implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
    runnerMocks.planner = undefined;
    runnerMocks.implementer = undefined;
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it('emits budget_paused JSON and fails fast through the public headless workflow path', async () => {
    const projectDir = setupProject();
    const sessionId = beginSession(projectDir, 'fix budget behavior');

    await expect(
      runHeadless('fix budget behavior', projectDir, {}, makeBudgetState(), sessionId),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Recovery required'),
    });

    const output = stdoutChunks.join('');
    const jsonLines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as {
        type?: string;
        currentCost?: number;
        maxBudget?: number;
        threshold?: number;
        reason?: string;
        sessionId?: string;
      });
    const paused = jsonLines.find((line) => line.type === 'budget_paused');

    expect(runnerMocks.implementer?.implement).toHaveBeenCalled();
    expect(paused).toBeDefined();
    expect(paused?.currentCost).toBeGreaterThan(17);
    expect(paused?.maxBudget).toBe(20);
    expect(paused?.threshold).toBe(0.85);
    expect(jsonLines).toContainEqual(expect.objectContaining({
      type: 'recovery_required',
      sessionId,
      reason: 'budget-paused',
    }));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('uses the configured budgetPauseThreshold in the JSON output', async () => {
    const projectDir = setupProject();
    const config = makeBudgetConfig(0.75);
    mockLoadConfig.mockReturnValue({ config, warnings: [] });
    mockApplyCLIOverrides.mockReturnValue(config);

    await runHeadless('fix budget behavior', projectDir, {}, makeBudgetState());

    const pausedLine = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .find((line) => line.includes('"type":"budget_paused"'));
    expect(pausedLine).toBeDefined();
    const parsed = JSON.parse(pausedLine ?? '{}') as { threshold?: number };
    expect(parsed.threshold).toBe(0.75);
  });
});
