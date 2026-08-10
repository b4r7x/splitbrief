import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { beginSession, writeActive } from '../../../src/core/sessions/lifecycle.js';
import { listSessions } from '../../../src/core/sessions/io.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/task.js';
import { processError } from '../../../src/lib/process/errors.js';
import type { Implementer } from '../../../src/engine/implementers/types.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { runHeadless } from '../../../src/cli/headless.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

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
    const projectDir = createHeadlessGitProject('headless-recovery');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
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
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'recover me',
          resumeState: state,
        }),
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
    const projectDir = createHeadlessGitProject('headless-final-review');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
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
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'review me',
          resumeState: state,
        }),
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

describe('runHeadless — failed session exits non-zero', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

  it('exits non-zero when a watchdog idle-kill fails the session during planning', async () => {
    const projectDir = createTempDir('headless-failed-session');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = beginSession(projectDir, 'stall out');

    const stalledPlanner = makePlanner({
      quickPlan: vi
        .fn()
        .mockRejectedValue(processError.idleTimeout({ command: 'fake-planner', idleMs: 300_000 })),
    });

    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'stall out' }),
        _planner: stalledPlanner,
        _implementer: makeImplementer(),
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Workflow failed'),
    });

    const jsonLines = stdoutChunks
      .join('')
      .trim()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as { type?: string; message?: string });
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('status failed'),
      }),
    );
  }, 20_000);
});

describe('runHeadless — a tiered approval refusal stops the run', () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

  it('headless session ending interrupted without user abort exits non-zero and emits a machine-readable record', async () => {
    const projectDir = createHeadlessGitProject('headless-approval-stop');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-approval-stop';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });

    // A manifest edit classifies as package_change, whose confirm tier a headless
    // run has no way to answer: the task loop stops with the task untouched, no
    // pendingRecovery is raised and the session status stays 'interrupted'.
    const task = makeTask({ id: 'T001', action: 'modify', file: 'package.json' });
    const state = {
      ...createInitialState('bump the dependency'),
      phase: 'implementing' as const,
      tasks: [task],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
    saveState({ projectDir, sessionId }, state);

    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'bump the dependency',
          resumeState: state,
        }),
        _planner: makePlanner(),
        _implementer: makeImplementer(),
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Workflow did not complete'),
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
            message?: string;
            data?: { type?: string; tier?: string; reason?: string };
          },
      );
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'event',
        data: expect.objectContaining({ type: 'approval_rejected', reason: 'APPROVAL_REQUIRED' }),
      }),
    );
    expect(jsonLines).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('status interrupted'),
      }),
    );
    expect(listSessions(projectDir).find((s) => s.id === sessionId)?.status).toBe('interrupted');
  }, 20_000);
});
