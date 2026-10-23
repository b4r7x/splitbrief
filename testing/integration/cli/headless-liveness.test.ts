import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { sessionDir } from '../../../src/core/paths.js';
import {
  readLockfile,
  checkSessionLiveness,
  markExited,
} from '../../../src/core/sessions/lockfile.js';
import type { LockfileData } from '../../../src/core/sessions/lockfile.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { runHeadless } from '../../../src/cli/headless.js';
import { readRunRecord } from '../../../src/core/sessions/run-record-io.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { sessionStatusWord } from '../../../src/core/sessions/display.js';

vi.mock('../../../src/core/sessions/lockfile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/sessions/lockfile.js')>();
  return { ...actual, markExited: vi.fn(actual.markExited) };
});

let stderrSpy: ReturnType<typeof vi.spyOn>;
let dirs: string[] = [];

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

  function makeTaskForFile(id: string, file: string) {
    return {
      ...makePassingTask(id),
      suggestedFiles: [file] as [string],
      scope: {
        inBounds: [file],
        outOfBounds: ['Do not touch anything outside the task file.'],
      },
    };
  }

  function setupLivenessProject(): { projectDir: string; sessionId: string } {
    const projectDir = createHeadlessGitProject('headless-liveness');
    dirs.push(projectDir);
    writeMinimalHeadlessConfigYaml(projectDir);
    const sessionId = 'sess-headless-liveness';
    ensureSessionDir(projectDir, sessionId);
    writeActive({ projectDir, sessionId });
    const state: WorkflowState = {
      ...createInitialState('liveness feature'),
      phase: 'implementing',
      tasks: [makeTaskForFile('T001', 'src/one.ts')],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };
    persistReadyExecutionState({ projectDir, sessionId }, state);
    return { projectDir, sessionId };
  }

  it('records live and exited liveness state across one headless run', async () => {
    const { projectDir, sessionId } = setupLivenessProject();
    const dir = sessionDir(projectDir, sessionId);
    const before = Date.now();
    const midRunLocks: Array<LockfileData | null> = [];
    const implement = vi.fn().mockImplementation(async () => {
      midRunLocks.push(readLockfile(dir));
      return { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const implementer = makeImplementer({ implement });
    const state = {
      ...createInitialState('liveness feature'),
      phase: 'implementing' as const,
      tasks: [makeTaskForFile('T001', 'src/one.ts')],
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    };

    const resumeState = persistReadyExecutionState({ projectDir, sessionId }, state);
    await runHeadless({
      prepared: preparedHeadlessExecution({
        projectDir,
        sessionId,
        feature: 'liveness feature',
        resumeState,
      }),
      _planner: planner,
      _implementer: implementer,
    });
    expect(midRunLocks).toHaveLength(1);
    const midRunLock = midRunLocks[0];
    expect(midRunLock).not.toBeNull();
    expect(midRunLock?.pid).toBe(process.pid);
    expect(midRunLock?.sessionId).toBe(sessionId);
    expect(midRunLock?.feature).toBe('liveness feature');
    expect(midRunLock?.lastAliveMs).toBeGreaterThanOrEqual(before);
    expect(midRunLock?.exitedAt).toBeUndefined();

    let status = checkSessionLiveness(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = checkSessionLiveness(dir);
    }
    expect(status.alive).toBe(false);
    const lock = readLockfile(dir);
    expect(lock?.exitedAt).toBeDefined();
  }, 30_000);

  it.each([
    [
      'comes to Apply',
      { success: true, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      'resolved',
      'ready to apply',
    ],
    ['halts', { success: false, output: '', error: 'build broke' }, 'rejected', 'waiting for you'],
  ])(
    'names the run lock once, whole, on stderr when a run that %s cannot release it',
    async (_outcome, result, settled, status) => {
      const { projectDir, sessionId } = setupLivenessProject();
      vi.mocked(markExited).mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied, open '/x/lockfile.json'"), {
          code: 'EACCES',
        }),
      );
      const implementer = makeImplementer({
        implement: vi.fn().mockResolvedValue(result),
        retry: vi.fn().mockResolvedValue(result),
      });
      const resumeState = persistReadyExecutionState(
        { projectDir, sessionId },
        {
          ...createInitialState('liveness feature'),
          phase: 'implementing',
          tasks: [makeTaskForFile('T001', 'src/one.ts')],
          plannerTool: 'claude-code',
          implementerTool: 'ollama',
        },
      );

      const outcome = await runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir,
          sessionId,
          feature: 'liveness feature',
          resumeState,
        }),
        _planner: planner,
        _implementer: implementer,
      }).then(
        () => 'resolved',
        () => 'rejected',
      );

      expect(outcome).toBe(settled);
      const session = readSession({ projectDir, sessionId });
      expect(session === null ? null : sessionStatusWord(session)).toBe(status);
      expect(readRunRecord({ projectDir, sessionId }).status.kind).toBe('running');
      const lines = stderrSpy.mock.calls
        .map(([chunk]: [unknown]) => String(chunk))
        .filter((line: string) => line.includes('lockfile.json'));
      expect(lines).toEqual([
        `Could not release the run lock: permission denied · .splitbrief/sessions/${sessionId}/lockfile.json · other SPLITBRIEF processes can see the run as running for a few more seconds\n`,
      ]);
    },
    30_000,
  );
});
