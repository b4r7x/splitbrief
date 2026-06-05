import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { saveState } from '../core/state/persistence.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { Planner } from '../engine/planners/types.js';
import { beginSession, writeActive } from '../core/sessions/lifecycle.js';
import { buildRetryExhaustedRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../core/paths.js';
import { runHeadless } from './headless.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;

function writeConfigYaml(projectDir: string, yamlLines: string[]): void {
  const dir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, CONFIG_FILE);
  writeFileSync(filePath, yamlLines.join('\n'));
  chmodSync(filePath, 0o600);
}

function writeBudgetConfigYaml(projectDir: string, pauseThreshold = 0.85): void {
  writeConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: api',
    '  provider: anthropic',
    '  model: claude-sonnet-4-6',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    'implementer:',
    '  kind: api',
    '  provider: anthropic',
    '  model: claude-sonnet-4-6',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  mode: quick',
    '  auto_approve_spec: true',
    '  auto_approve_plan: true',
    '  approve: none',
    '  commit_strategy: none',
    '  persist_transcript: false',
    '  max_budget: 20',
    `  budget_pause_threshold: ${pauseThreshold}`,
  ]);
}

function writeMinimalConfigYaml(projectDir: string): void {
  writeConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  auto_approve_spec: true',
    '  auto_approve_plan: true',
    '  approve: none',
    '  commit_strategy: none',
    '  mode: quick',
    '  persist_transcript: false',
  ]);
}

let dirs: string[] = [];

function setupProject(pauseThreshold = 0.85): string {
  const projectDir = createTempDir('headless-budget-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  writeBudgetConfigYaml(projectDir, pauseThreshold);
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
    implementationSteps: [
      '1. Run the implementation once',
      '2. Stop at the budget pause threshold',
    ],
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
  let planner: Planner;
  let implementer: Implementer;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code: number | string | null | undefined,
    ) => {
      const err = new Error(`process.exit(${String(code)})`) as Error & {
        code: number | string | null | undefined;
      };
      err.code = code;
      throw err;
    }) as never);

    planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: '', usage: null }),
    });
    implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'done',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it('emits budget_paused JSON and fails fast through the public headless workflow path', async () => {
    const projectDir = setupProject();
    const sessionId = beginSession(projectDir, 'fix budget behavior');

    await expect(
      runHeadless({
        feature: 'fix budget behavior',
        projectDir: projectDir,
        opts: {},
        savedState: makeBudgetState(),
        sessionId: sessionId,
        _planner: planner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Recovery required'),
    });

    const output = stdoutChunks.join('');
    const jsonLines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            currentCost?: number;
            maxBudget?: number;
            threshold?: number;
            reason?: string;
            sessionId?: string;
          },
      );
    const paused = jsonLines.find((line) => line.type === 'budget_paused');

    expect(paused).toBeDefined();
    expect(paused?.currentCost).toBeGreaterThan(17);
    expect(paused?.maxBudget).toBe(20);
    expect(paused?.threshold).toBe(0.85);
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'recovery_required',
        sessionId,
        reason: 'budget-paused',
      }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('uses the configured budgetPauseThreshold in the JSON output', async () => {
    const projectDir = setupProject(0.75);

    await runHeadless({
      feature: 'fix budget behavior',
      projectDir: projectDir,
      opts: {},
      savedState: makeBudgetState(),
      _planner: planner,
      _implementer: implementer,
    });

    const pausedLine = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .find((line) => line.includes('"type":"budget_paused"'));
    expect(pausedLine).toBeDefined();
    const parsed = JSON.parse(pausedLine ?? '{}') as { threshold?: number };
    expect(parsed.threshold).toBe(0.75);
  });

  it('rejects interactive task review modes before starting a headless run', async () => {
    const projectDir = setupProject();
    writeConfigYaml(projectDir, [
      'version: 3',
      'planner:',
      '  kind: api',
      '  provider: anthropic',
      '  model: claude-sonnet-4-6',
      '  api_base: https://api.anthropic.com/v1',
      '  api_key: test-key',
      'implementer:',
      '  kind: api',
      '  provider: anthropic',
      '  model: claude-sonnet-4-6',
      '  api_base: https://api.anthropic.com/v1',
      '  api_key: test-key',
      'validation:',
      '  typecheck: false',
      '  lint: false',
      '  test: false',
      '  test_command: "noop"',
      'workflow:',
      '  mode: quick',
      '  auto_approve_spec: true',
      '  auto_approve_plan: true',
      '  approve: none',
      '  commit_strategy: none',
      '  persist_transcript: false',
      '  max_budget: 20',
      '  budget_pause_threshold: 0.85',
      '  task_review: every',
    ]);

    await expect(
      runHeadless({
        feature: 'fix budget behavior',
        projectDir: projectDir,
        opts: {},
        savedState: makeBudgetState(),
        _planner: planner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('workflow.taskReview requires an interactive TUI run'),
    });
    expect(stdoutChunks.join('')).toBe('');
  });
});

describe('runHeadless — recovery stops', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;
  let implementer: Implementer;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    planner = makePlanner();
    implementer = makeImplementer();
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  it('emits machine-readable recovery actions and exits non-zero when a run leaves pending recovery', async () => {
    const projectDir = createTempDir('headless-recovery');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    writeMinimalConfigYaml(projectDir);
    const sessionId = 'sess-headless-recovery';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const task = makeTask({ id: 'T001' });
    const issue = buildRetryExhaustedRecoveryIssue({
      task,
      validationSummary: 'npm test failed',
      attempts: 2,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const state = transition(
      {
        ...createInitialState('recover me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      { type: 'SET_PENDING_RECOVERY', issue },
    );
    saveState({ projectDir, sessionId }, state);

    await expect(
      runHeadless({
        feature: 'recover me',
        projectDir: projectDir,
        opts: {},
        savedState: state,
        sessionId: sessionId,
        _planner: planner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Recovery required'),
    });

    const jsonLines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            reason?: string;
            availableActions?: string[];
            sessionId?: string;
          },
      );
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'recovery_required',
        sessionId,
        reason: 'retry-exhausted',
        availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
      }),
    );
  });

  it('exits non-zero and emits final_review_failed when the final review gate fails', async () => {
    const projectDir = createTempDir('headless-final-review');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    writeMinimalConfigYaml(projectDir);
    const sessionId = 'sess-headless-final-review';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    const task = makeTask({ id: 'T001', status: 'done' });
    const state = {
      ...createInitialState('review me'),
      phase: 'implementing' as const,
      tasks: [task],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
    saveState({ projectDir, sessionId }, state);

    const failingPlanner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('planner review crashed')),
    });

    await expect(
      runHeadless({
        feature: 'review me',
        projectDir: projectDir,
        opts: {},
        savedState: state,
        sessionId: sessionId,
        _planner: failingPlanner,
        _implementer: implementer,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Final review did not pass'),
    });

    const jsonLines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { type?: string; sessionId?: string });
    expect(jsonLines).toContainEqual(
      expect.objectContaining({ type: 'final_review_failed', sessionId }),
    );
  });
});
