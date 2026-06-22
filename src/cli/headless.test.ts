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
import {
  beginSession,
  TRANSCRIPT_OMITTED_FEATURE,
  writeActive,
} from '../core/sessions/lifecycle.js';
import { buildRetryExhaustedRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { listSessions } from '../core/sessions/io.js';
import { DIPTYCH_DIR, CONFIG_FILE, sessionDir } from '../core/paths.js';
import { readLockfile, checkServerStatus } from '../engine/ipc/lockfile.js';
import type { LockfileData } from '../engine/ipc/lockfile.js';
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
            data?: {
              type?: string;
              currentCost?: number;
              maxBudget?: number;
              threshold?: number;
            };
            currentCost?: number;
            maxBudget?: number;
            threshold?: number;
            reason?: string;
            sessionId?: string;
          },
      );
    const paused = jsonLines.find(
      (line) => line.type === 'event' && line.data?.type === 'budget_paused',
    )?.data;

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
      message: expect.stringContaining('Recovery required'),
    });

    const pausedLine = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .find((line) => line.includes('"type":"budget_paused"'));
    expect(pausedLine).toBeDefined();
    const parsed = JSON.parse(pausedLine ?? '{}') as {
      type?: string;
      data?: { type?: string; threshold?: number };
    };
    expect(parsed.type).toBe('event');
    expect(parsed.data?.type).toBe('budget_paused');
    expect(parsed.data?.threshold).toBe(0.75);
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
  }, 20_000);
});

describe('runHeadless — SIGINT/SIGTERM stops the run', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    planner = makePlanner();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function makeTwoTaskState(): WorkflowState {
    return {
      ...createInitialState('stop me'),
      phase: 'implementing',
      tasks: [
        makeTask({ id: 'T001', file: 'src/one.ts' }),
        makeTask({ id: 'T002', file: 'src/two.ts' }),
      ],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
  }

  function setupSignalProject(): { projectDir: string; sessionId: string } {
    const projectDir = createTempDir('headless-signal');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    writeMinimalConfigYaml(projectDir);
    const sessionId = 'sess-headless-signal';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    saveState({ projectDir, sessionId }, makeTwoTaskState());
    return { projectDir, sessionId };
  }

  it('aborts the workflow on SIGINT and records the session as interrupted, not failed', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });

    await runHeadless({
      feature: 'stop me',
      projectDir,
      opts: {},
      savedState: makeTwoTaskState(),
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);
    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('stops the run on SIGTERM the same way', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGTERM');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });

    await runHeadless({
      feature: 'stop me',
      projectDir,
      opts: {},
      savedState: makeTwoTaskState(),
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);
    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('does not emit retry or escalation events after a mid-run SIGINT (no paid churn)', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const stdoutChunks: string[] = [];
    stdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: false, output: '', error: 'broken code', usage: null };
    });
    const implementer = makeImplementer({ implement });

    await runHeadless({
      feature: 'stop me',
      projectDir,
      opts: {},
      savedState: makeTwoTaskState(),
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    expect(implement).toHaveBeenCalledTimes(1);

    const emittedTypes = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        const parsed = JSON.parse(line) as { type?: string; data?: { type?: string } };
        return parsed.type === 'event' ? parsed.data?.type : parsed.type;
      });
    expect(emittedTypes).not.toContain('task_retry');
    expect(emittedTypes).not.toContain('task_escalating');
    expect(emittedTypes).not.toContain('escalate');

    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.status).toBe('interrupted');
  });

  it('leaves a broken-pipe guard on stdout and stderr so a closed consumer cannot crash the run', async () => {
    const { projectDir, sessionId } = setupSignalProject();
    const implement = vi.fn().mockImplementation(async () => {
      process.emit('SIGINT');
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });

    await runHeadless({
      feature: 'stop me',
      projectDir,
      opts: {},
      savedState: makeTwoTaskState(),
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    expect(() => process.stdout.emit('error', epipe)).not.toThrow();
    expect(() => process.stderr.emit('error', epipe)).not.toThrow();
  });
});

describe('runHeadless — liveness record (F-261)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let planner: Planner;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    planner = makePlanner();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
    for (const d of dirs) cleanupTempDir(d);
    dirs = [];
  });

  function setupLivenessProject(): { projectDir: string; sessionId: string } {
    const projectDir = createTempDir('headless-liveness');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    writeMinimalConfigYaml(projectDir);
    const sessionId = 'sess-headless-liveness';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state: WorkflowState = {
      ...createInitialState('liveness feature'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', file: 'src/one.ts' })],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
    saveState({ projectDir, sessionId }, state);
    return { projectDir, sessionId };
  }

  it('writes a live liveness record (pid + fresh heartbeat, not exited) while the headless run is in flight', async () => {
    const { projectDir, sessionId } = setupLivenessProject();
    const dir = sessionDir(projectDir, sessionId);
    const before = Date.now();
    const midRunLocks: Array<LockfileData | null> = [];
    const implement = vi.fn().mockImplementation(async () => {
      midRunLocks.push(await readLockfile(dir));
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });

    await runHeadless({
      feature: 'liveness feature',
      projectDir,
      opts: {},
      savedState: {
        ...createInitialState('liveness feature'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001', file: 'src/one.ts' })],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    expect(midRunLocks).toHaveLength(1);
    const midRunLock = midRunLocks[0];
    expect(midRunLock).not.toBeNull();
    expect(midRunLock?.pid).toBe(process.pid);
    expect(midRunLock?.sessionId).toBe(sessionId);
    expect(midRunLock?.feature).toBe(TRANSCRIPT_OMITTED_FEATURE);
    expect(midRunLock?.lastAliveMs).toBeGreaterThanOrEqual(before);
    expect(midRunLock?.exitedAt).toBeUndefined();
  });

  it('marks the liveness record exited once the headless run finishes so it no longer reads as alive', async () => {
    const { projectDir, sessionId } = setupLivenessProject();
    const dir = sessionDir(projectDir, sessionId);
    const implementer = makeImplementer();

    await runHeadless({
      feature: 'liveness feature',
      projectDir,
      opts: {},
      savedState: {
        ...createInitialState('liveness feature'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001', file: 'src/one.ts' })],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      sessionId,
      _planner: planner,
      _implementer: implementer,
    });

    let status = await checkServerStatus(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await checkServerStatus(dir);
    }
    expect(status.alive).toBe(false);
    const lock = await readLockfile(dir);
    expect(lock?.exitedAt).toBeDefined();
  }, 20_000);
});
