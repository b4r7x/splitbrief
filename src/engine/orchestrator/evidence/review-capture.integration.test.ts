import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCallbacks, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
  setupTaskProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { sessionDir } from '../../../core/paths.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { captureTaskReviewChanges } from './review-capture.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { appendReviewChanges, readReviewChanges } from '../../../core/evidence/review-changes.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import type { ImplementerOptions } from '../../implementers/types.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createRunIsolation } from '../isolation/create.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { runSingleTask } from '../task/step.js';
import { resolveRunReviewScope } from './review-packet/run-scope.js';

const SHARED = 'src/shared.ts';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTaskProjects();
});

describe('captureTaskReviewChanges', () => {
  it('review diff is one diff for the shared file, attributed to both tasks', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const first = makeTask({ id: 'T001', action: 'create', suggestedFiles: [SHARED] });
    const second = makeTask({ id: 'T002', action: 'modify', suggestedFiles: [SHARED] });
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi
        .fn()
        .mockImplementation(async ({ projectDir: dir, task }: ImplementerOptions) => {
          mkdirSync(join(dir, 'src'), { recursive: true });
          const line = task.id === 'T001' ? 'export const a = 1;\n' : 'export const b = 2;\n';
          const current = task.id === 'T001' ? '' : readFileSync(join(dir, SHARED), 'utf8');
          writeFileSync(join(dir, SHARED), current + line);
          return { success: true, output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
        }),
    });
    const config = makeConfig({ workflow: { review: 'task' } });
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
    });
    const workspaceDir = (await isolation.open({ config })).projectDir;
    const wctx = makeTaskWorkflowContext({
      projectDir,
      sessionId,
      workspaceDir,
      callbacks: makeCallbacks().callbacks,
      implementer,
      config,
      isolation,
    });
    const common = { wctx, taskBreakdowns: [], setTrackedState: vi.fn(), setCurrentTask: vi.fn() };

    let state = implementingState([first, second]);
    state = await runSingleTask({ ...common, task: first, index: 0, totalTasks: 2, state });
    state = await runSingleTask({ ...common, task: second, index: 1, totalTasks: 2, state });

    expect(state.tasks.map((task) => task.status)).toEqual(['done', 'done']);
    const changes = readReviewChanges({ projectDir, sessionId })?.changes ?? [];
    expect(changes.map((change) => [change.taskId, change.path, change.kind])).toEqual([
      ['T001', SHARED, 'captured'],
      ['T002', SHARED, 'captured'],
    ]);
    const scope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: state.tasks,
      workspaceFiles: [SHARED],
      workspaceDiff: '',
      preRunFiles: [],
    });
    expect(scope.files.map((entry) => [entry.path, entry.taskIds])).toEqual([
      [SHARED, ['T001', 'T002']],
    ]);
    const diff = scope.files[0]?.diff ?? '';
    expect(diff.split('+export const a = 1;')).toHaveLength(2);
    expect(diff.split('+export const b = 2;')).toHaveLength(2);
    expect(scope.provenance.uncertainFiles).toEqual([]);
    await isolation.dispose();
  });

  it('records what every attempt of a retried task left, not only the last attempt', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: ['src/a.ts', 'src/b.ts'],
      checks: [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }],
    });
    const write = (file: string) =>
      vi.fn().mockImplementation(async ({ projectDir: dir }: ImplementerOptions) => {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, file), `export const done = '${file}';\n`);
        return { success: true, output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
      });
    const config = makeConfig({ workflow: { review: 'task' } });
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
    });
    const workspaceDir = (await isolation.open({ config })).projectDir;
    // The brief check fails on the first attempt and passes once the retry writes src/b.ts.
    vi.spyOn(commandRunner, 'runCommand')
      .mockRejectedValueOnce(
        processError.exitCode({ command: 'tsc', code: 2, stderr: 'b is missing', output: '' }),
      )
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const state = await runSingleTask({
      wctx: makeTaskWorkflowContext({
        projectDir,
        sessionId,
        workspaceDir,
        implementer: makeImplementer({
          capabilities: { writesFiles: 'direct' },
          implement: write('src/a.ts'),
          retry: write('src/b.ts'),
        }),
        config,
        isolation,
      }),
      task,
      index: 0,
      totalTasks: 1,
      state: implementingState([task]),
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });
    await isolation.dispose();

    expect(state.tasks[0]?.status).toBe('done');
    const changes = readReviewChanges({ projectDir, sessionId })?.changes ?? [];
    expect(changes.map((change) => [change.taskId, change.path, change.kind])).toEqual([
      ['T001', 'src/a.ts', 'captured'],
      ['T001', 'src/b.ts', 'captured'],
    ]);
  });

  it('judges later edits against the run workspace, not the checkout', async () => {
    const { projectDir, sessionId } = setupTaskProject();
    const workspaceDir = setupTaskProject().projectDir;
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: [SHARED] });
    const after = 'export const a = 1;\n';
    for (const dir of [projectDir, workspaceDir]) mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(workspaceDir, SHARED), after);
    writeFileSync(join(projectDir, SHARED), 'export const operator = true;\n');
    appendReviewChanges({ projectDir, sessionId }, [
      {
        taskId: task.id,
        briefHash: hashTaskBrief([task]),
        path: SHARED,
        kind: 'captured',
        before: null,
        after: {
          base64: Buffer.from(after).toString('base64'),
          sha256: sha256Hex(after),
          mode: 0o644,
        },
      },
    ]);

    const scope = await resolveRunReviewScope({
      ref: { projectDir, sessionId },
      workspaceDir,
      tasks: [task],
      workspaceFiles: [SHARED],
      workspaceDiff: '',
      preRunFiles: [],
    });

    expect(scope.laterDiff).toBe('');
    expect(scope.provenance.uncertainFiles).toEqual([]);
    expect(scope.files[0]?.diff).toContain('+export const a = 1;');
  });
});

describe('captureTaskReviewChanges from an entry snapshot (no git)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) cleanupTempDir(dir);
    dir = '';
  });

  it('records the real before bytes, a deletion and a mode-only change', async () => {
    dir = createTempDir('review-capture-entries-');
    const ref = { projectDir: dir, sessionId: 'sess-entries' };
    mkdirSync(sessionDir(dir, ref.sessionId), { recursive: true });
    writeFileSync(join(dir, 'edit.txt'), 'before\n');
    writeFileSync(join(dir, 'gone.txt'), 'deleted by the task\n');
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(dir, 'run.sh'), 0o644);
    mkdirSync(join(dir, 'docs'));
    symlinkSync('../edit.txt', join(dir, 'docs/readme.md'));
    symlinkSync('edit.txt', join(dir, 'gone-link'));
    const taskStartSnapshot = await captureWorkspaceSnapshot(dir, ref);
    writeFileSync(join(dir, 'edit.txt'), 'after\n');
    rmSync(join(dir, 'gone.txt'));
    chmodSync(join(dir, 'run.sh'), 0o755);
    rmSync(join(dir, 'docs/readme.md'));
    symlinkSync('../run.sh', join(dir, 'docs/readme.md'));
    rmSync(join(dir, 'gone-link'));
    symlinkSync('run.sh', join(dir, 'new-link'));
    const task = makeTask({ id: 'T001', action: 'modify', suggestedFiles: ['edit.txt'] });

    await captureTaskReviewChanges({
      ref,
      workspaceDir: dir,
      task,
      since: taskStartSnapshot,
      files: await getChangedFilesSinceSnapshot(dir, taskStartSnapshot),
    });

    const changes = new Map(
      (readReviewChanges(ref)?.changes ?? []).map((change) => [change.path, change]),
    );
    const decoded = (path: string, side: 'before' | 'after') => {
      const change = changes.get(path);
      if (change?.kind !== 'captured') return `not captured: ${change?.kind}`;
      const entry = change[side];
      if (entry === null) return null;
      return 'symlink' in entry
        ? `-> ${entry.symlink}`
        : Buffer.from(entry.base64, 'base64').toString('utf8');
    };
    expect(decoded('edit.txt', 'before')).toBe('before\n');
    expect(decoded('edit.txt', 'after')).toBe('after\n');
    expect(decoded('gone.txt', 'before')).toBe('deleted by the task\n');
    expect(decoded('gone.txt', 'after')).toBeNull();
    const mode = changes.get('run.sh');
    expect(mode).toMatchObject({ before: { mode: 0o644 }, after: { mode: 0o755 } });
    expect(decoded('docs/readme.md', 'before')).toBe('-> ../edit.txt');
    expect(decoded('docs/readme.md', 'after')).toBe('-> ../run.sh');
    expect(decoded('gone-link', 'before')).toBe('-> edit.txt');
    expect(decoded('gone-link', 'after')).toBeNull();
    expect(decoded('new-link', 'before')).toBeNull();
    expect(decoded('new-link', 'after')).toBe('-> run.sh');
  });
});

describe('captureTaskReviewChanges from a git workspace', () => {
  let dir = '';
  afterEach(() => {
    if (dir) cleanupTempDir(dir);
    dir = '';
  });

  it('records committed, dirty and new symlinks by target, and a mode-only change', async () => {
    dir = createTempDir('review-capture-links-');
    const ref = { projectDir: dir, sessionId: 'sess-links' };
    mkdirSync(sessionDir(dir, ref.sessionId), { recursive: true });
    createTestGitRepo(dir, { 'a.txt': 'same\n', 'b.txt': 'same\n', 'src/cli.js': 'run\n' });
    chmodSync(join(dir, 'src/cli.js'), 0o644);
    symlinkSync('a.txt', join(dir, 'retargeted'));
    symlinkSync('a.txt', join(dir, 'removed'));
    execSync('git add -A && git commit -q -m links', { cwd: dir, stdio: 'pipe' });
    symlinkSync('a.txt', join(dir, 'dirty'));
    const taskStartSnapshot = await captureWorkspaceSnapshot(dir, ref);
    chmodSync(join(dir, 'src/cli.js'), 0o755);
    symlinkSync('b.txt', join(dir, 'created'));
    for (const link of ['retargeted', 'dirty']) {
      rmSync(join(dir, link));
      symlinkSync('b.txt', join(dir, link));
    }
    rmSync(join(dir, 'removed'));
    const task = makeTask({ id: 'T001', action: 'modify', suggestedFiles: ['src/cli.js'] });

    await captureTaskReviewChanges({
      ref,
      workspaceDir: dir,
      task,
      since: taskStartSnapshot,
      files: await getChangedFilesSinceSnapshot(dir, taskStartSnapshot),
    });

    const changes = Object.fromEntries(
      (readReviewChanges(ref)?.changes ?? []).map((change) => [
        change.path,
        change.kind === 'captured' ? [change.before, change.after] : change.kind,
      ]),
    );
    expect(changes).toEqual({
      created: [null, { symlink: 'b.txt' }],
      dirty: [{ symlink: 'a.txt' }, { symlink: 'b.txt' }],
      removed: [{ symlink: 'a.txt' }, null],
      retargeted: [{ symlink: 'a.txt' }, { symlink: 'b.txt' }],
      'src/cli.js': [
        expect.objectContaining({ mode: 0o644 }),
        expect.objectContaining({ mode: 0o755 }),
      ],
    });
  });
});
