import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeCopyingIsolation, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { runCodeDir, runTasksAndReview } from './task-execution.js';
import { initializeWorkflow } from './init.js';
import { baselineDir, snapshotManifestPath } from '../../../core/paths.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), writeFile: vi.fn(actual.writeFile) };
});
vi.mock('../../../lib/git/repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/git/repository.js')>()),
  isGitRepo: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../lib/git/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/git/files.js')>()),
  checkIgnoredPaths: vi.fn().mockResolvedValue([]),
  listTrackedAndUntrackedFiles: vi.fn().mockResolvedValue(null),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('workspace acquisition conformance', () => {
  it('halts if the session baseline disappears before workspace-base capture', async () => {
    const projectDir = createTempDir('run-baseline-race');
    dirs.push(projectDir);
    const sessionId = 'run-baseline-race';
    const ref = { projectDir, sessionId };
    writeFileSync(join(projectDir, 'source.txt'), 'baseline input');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let observations = 0;
    vi.mocked(stat).mockImplementation(async (...args) => {
      if (args[0] === snapshotManifestPath(ref, 'baseline')) {
        observations += 1;
        if (observations === 3) {
          const found = await actual.stat(...args);
          await rm(baselineDir(ref), { recursive: true });
          return found;
        }
      }
      return actual.stat(...args);
    });
    const stopped = new AbortController();
    stopped.abort();
    const wctx = makeWctx({
      projectDir,
      sessionId,
      signal: stopped.signal,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
    });
    const opening = vi.spyOn(wctx.isolation, 'open');
    const state = makeImplState([]);
    await expect(
      runTasksAndReview({
        wctx,
        state,
        planning: { disposition: 'ready-for-tasks', state, tasks: [] },
        summaryBase: {
          feature: 'baseline race',
          startTime: Date.now(),
          projectDir,
          sessionId,
          plannerTool: 'test',
          implementerTool: 'test',
        },
        phaseTimings: {},
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      }),
    ).rejects.toMatchObject({ kind: 'run-workspace-base-is-baseline' });
    expect(opening).not.toHaveBeenCalled();
    await wctx.isolation.dispose();
  });

  it('restarts an interrupted staged task in the workspace, preserving earlier work and checkout edits', async () => {
    const projectDir = createTempDir('staged-task-restart');
    dirs.push(projectDir);
    const sessionId = 'staged-task-restart';
    const feature = 'restart in the workspace';
    writeFileSync(join(projectDir, 'source.txt'), 'checkout\n');
    writeFileSync(join(projectDir, 'deleted.txt'), 'pre-task deletion input\n');
    const wctx = makeWctx({
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
    });
    const opened = await wctx.isolation.open({ config: wctx.config });
    writeFileSync(join(opened.projectDir, 'source.txt'), 'pre-task input\n');
    writeFileSync(join(opened.projectDir, 'earlier.txt'), 'earlier task\n');
    const snapshot = (await wctx.isolation.acquire({ role: 'implementer', config: wctx.config }))
      .snapshot;
    writeFileSync(join(opened.projectDir, 'source.txt'), 'interrupted output\n');
    rmSync(join(opened.projectDir, 'deleted.txt'));
    writeFileSync(join(projectDir, 'source.txt'), 'operator edit\n');
    const task = makeTask({
      id: 'T001',
      status: 'in_progress',
      suggestedFiles: ['source.txt', 'deleted.txt'],
    });
    const state = {
      ...makeImplState([task]),
      phase: 'validating-task' as const,
      attempt: 2,
      workspace: {
        kind: opened.kind,
        path: opened.projectDir,
        base: { snapshotId: 'workspace-base', head: null },
      },
      changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: snapshot },
    };
    const setTrackedState = vi.fn();
    const result = await initializeWorkflow({
      opts: {
        prepared: makePreparedExecution({
          projectDir,
          sessionId,
          feature,
          config: wctx.config,
          resumeState: state,
        }),
        callbacks: wctx.callbacks,
        sinks: wctx.sinks,
        savedState: state,
        _planner: wctx.planner,
        _implementer: wctx.implementer,
      },
      config: wctx.config,
      sessionId,
      savedState: state,
      setTrackedState,
      summaryBase: {
        feature,
        startTime: Date.now(),
        projectDir,
        sessionId,
        plannerTool: 'test',
        implementerTool: 'test',
      },
      metadata: { planner: { tool: 'test' }, implementer: { tool: 'test' } },
      resumeHolder: { messages: [] },
      isolation: wctx.isolation,
    });
    expect(result.ok).toBe(true);
    expect(setTrackedState.mock.lastCall?.[0]).toMatchObject({
      phase: 'implementing',
      attempt: 0,
      tasks: [{ id: 'T001', status: 'pending' }],
    });
    expect(readFileSync(join(opened.projectDir, 'source.txt'), 'utf8')).toBe('pre-task input\n');
    expect(readFileSync(join(opened.projectDir, 'deleted.txt'), 'utf8')).toBe(
      'pre-task deletion input\n',
    );
    expect(readFileSync(join(opened.projectDir, 'earlier.txt'), 'utf8')).toBe('earlier task\n');
    expect(readFileSync(join(projectDir, 'source.txt'), 'utf8')).toBe('operator edit\n');
    expect(existsSync(join(projectDir, 'earlier.txt'))).toBe(false);
    await wctx.isolation.dispose();
  });

  it('halts before opening a workspace when the session baseline cannot be initialized', async () => {
    const projectDir = createTempDir('run-baseline-failure');
    dirs.push(projectDir);
    const sessionId = 'run-baseline-failure';
    writeFileSync(join(projectDir, 'source.txt'), 'baseline input');
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('baseline storage failed once'));
    const wctx = makeWctx({
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
    });
    const opening = vi.spyOn(wctx.isolation, 'open');
    const state = makeImplState([]);
    await expect(
      runTasksAndReview({
        wctx,
        state,
        planning: { disposition: 'ready-for-tasks', state, tasks: [] },
        summaryBase: {
          feature: 'baseline failure',
          startTime: Date.now(),
          projectDir,
          sessionId,
          plannerTool: 'test',
          implementerTool: 'test',
        },
        phaseTimings: {},
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      }),
    ).rejects.toMatchObject({ kind: 'run-baseline-snapshot-missing' });
    expect(opening).not.toHaveBeenCalled();
    await wctx.isolation.dispose();
  });

  it.each(['worktree', 'staged-copy'] as const)(
    'selects the recorded %s workspace for execution and restart',
    (kind) => {
      expect(
        runCodeDir('/checkout', {
          kind,
          path: '/workspace',
          base: { snapshotId: 'workspace-base', head: null },
        }),
      ).toBe('/workspace');
      expect(runCodeDir('/checkout', undefined)).toBe('/checkout');
    },
  );
});
