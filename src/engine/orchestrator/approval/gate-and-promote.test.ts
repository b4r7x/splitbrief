import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { createStagedProject } from './staged-project.js';
import { gateAndPromoteChangedFiles, type GateAndPromoteOpts } from './gate-and-promote.js';
import { getChangedFilesSnapshot } from './file-snapshots/capture.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

type GateArgs = Pick<
  GateAndPromoteOpts,
  'task' | 'state' | 'projectDir' | 'workspace' | 'taskStartSnapshot'
> &
  Partial<GateAndPromoteOpts>;

function runGate(args: GateArgs) {
  return gateAndPromoteChangedFiles({
    sessionId: 'sess-gate',
    bus: makeBusRecorder().bus,
    callbacks: makeCallbacks().callbacks,
    config: makeNoValidationConfig({
      approval: { enabled: false, feedRejectionsToPlanner: true },
    }),
    dependsOnFiles: [],
    handleConflict: async (s) => s,
    onApproved: () => {},
    ...args,
  });
}

// An empty repository, never staged and never committed: the files below stay
// untracked, which is all the changed-file scan needs.
function initEmptyRepo(dir: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'Test']);
}

async function acquiredProject(name: string) {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  initEmptyRepo(projectDir);
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');

  const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
  const workspace = await createStagedProject({ projectDir: projectDir });
  dirs.push(workspace.projectDir);
  writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'worker\n');
  return { projectDir, workspace, taskStartSnapshot };
}

describe('gateAndPromoteChangedFiles', () => {
  it('promotes the allowed files and drops only the denied protected write', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-partial');
    writeFileSync(join(workspace.projectDir, '.env.local'), 'TOKEN=1\n');
    const task = makeTask({ id: 'T011', file: 'src/app.ts' });

    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
      callbacks: makeCallbacks({
        onTieredApproval: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'no' }),
      }).callbacks,
    });

    expect(outcome).toMatchObject({
      outcome: 'allow',
      changedFiles: ['src/app.ts'],
      denial: { discardedFiles: ['.env.local'] },
    });
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf8')).toBe('worker\n');
    expect(existsSync(join(projectDir, '.env.local'))).toBe(false);
  });

  itUnix(
    'returns a handled error outcome and retains the workspace when promotion throws',
    async () => {
      const projectDir = createTempDir('gate-promote-project');
      const outsideDir = createTempDir('gate-promote-outside');
      dirs.push(projectDir, outsideDir);

      createTestGitRepo(projectDir);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = true;\n');

      const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
      const workspace = await createStagedProject({ projectDir: projectDir });

      // Make the staged copy diverge so the gate sees a changed file to promote.
      writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

      // Replace the real target's parent with a symlink escaping the project, so the
      // post-mkdir path-confinement re-check inside promoteStagedChanges throws.
      rmSync(join(projectDir, 'src'), { recursive: true, force: true });
      symlinkSync(outsideDir, join(projectDir, 'src'));

      const task = makeTask({ id: 'T010', file: 'src/app.ts' });
      const state = makeImplState([task]);
      const cleanup = vi.fn(workspace.cleanup);

      const outcome = await runGate({
        task,
        state,
        projectDir,
        workspace,
        taskStartSnapshot,
        cleanup,
      });

      expect(outcome.outcome).toBe('error');
      // A throw cannot say how far the promotion got, so the workspace keeps the
      // worker's output instead of being disposed: cleanup must not run.
      expect(cleanup).not.toHaveBeenCalled();
      expect(existsSync(workspace.projectDir)).toBe(true);
      expect(existsSync(join(outsideDir, 'app.ts'))).toBe(false);
    },
  );

  it('does not promote or delete a project change discovered outside isolation', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir);

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject({ projectDir: projectDir });
    dirs.push(workspace.projectDir);

    // The staged copy has no src/user.ts; the user creates it in the real project
    // after the task-start snapshot, on the brief's own declared path.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'user.ts'), 'export const user = "after";\n');
    expect(existsSync(join(workspace.projectDir, 'src', 'user.ts'))).toBe(false);

    const task = makeTask({ id: 'T010', file: 'src/user.ts' });
    const state = makeImplState([task]);

    const outcome = await runGate({ task, state, projectDir, workspace, taskStartSnapshot });

    expect(outcome.outcome === 'allow' ? outcome.changedFiles : undefined).toEqual([]);
    expect(readFileSync(join(projectDir, 'src', 'user.ts'), 'utf-8')).toBe(
      'export const user = "after";\n',
    );
  });

  it('promotes a changed set discovered inside isolation', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir, { 'src/app.ts': 'export const app = true;\n' });

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject({ projectDir: projectDir });
    dirs.push(workspace.projectDir);

    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);

    const outcome = await runGate({ task, state, projectDir, workspace, taskStartSnapshot });

    expect(outcome.outcome).toBe('allow');
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'export const app = false;\n',
    );
  });

  it('aborts the whole promotion as a conflict when a file changes during approval', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir, { 'src/app.ts': 'export const app = true;\n' });

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject({ projectDir: projectDir });
    dirs.push(workspace.projectDir);

    writeFileSync(join(workspace.projectDir, 'src', 'app.ts'), 'export const app = false;\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const state = makeImplState([task]);

    const outcome = await runGate({
      task,
      state,
      projectDir,
      workspace,
      taskStartSnapshot,
      onApproved: () => {
        writeFileSync(join(projectDir, 'src', 'app.ts'), 'export const app = 1;\n');
      },
    });

    expect(outcome.outcome).toBe('promote-conflict');
    expect(outcome.outcome === 'promote-conflict' ? outcome.conflictedFiles : []).toEqual([
      'src/app.ts',
    ]);
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe(
      'export const app = 1;\n',
    );
  });

  it('conflicts on a post-acquisition user edit with approval disabled', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-baseline');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'user edit\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
    });

    expect(outcome.outcome).toBe('promote-conflict');
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
  });

  itUnix(
    'raises a promotion conflict over a project symlink the worker replaced with a file',
    async () => {
      const projectDir = createTempDir('gate-promote-link');
      dirs.push(projectDir);
      initEmptyRepo(projectDir);
      writeFileSync(join(projectDir, 'real.txt'), 'real\n');
      symlinkSync('real.txt', join(projectDir, 'link'));

      const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
      const workspace = await createStagedProject({ projectDir: projectDir });
      dirs.push(workspace.projectDir);
      rmSync(join(workspace.projectDir, 'link'));
      writeFileSync(join(workspace.projectDir, 'link'), 'worker\n');
      const conflicts: string[][] = [];

      const task = makeTask({ id: 'T010', file: 'link' });
      const outcome = await runGate({
        task,
        state: makeImplState([task]),
        projectDir,
        workspace,
        taskStartSnapshot,
        handleConflict: async (s, files) => {
          conflicts.push(files);
          return s;
        },
      });

      expect(outcome).toMatchObject({ outcome: 'promote-conflict', conflictedFiles: ['link'] });
      expect(conflicts).toEqual([['link']]);
      expect(readlinkSync(join(projectDir, 'link'))).toBe('real.txt');
    },
  );

  it('promotes an approved deletion of an untracked acquisition file to the target', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-baseline');
    // The worker deletes the file instead of editing it. It was untracked at
    // acquisition, so nothing but the baseline still records that it existed.
    rmSync(join(workspace.projectDir, 'src', 'app.ts'));

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
    });

    expect(outcome.outcome).toBe('allow');
    expect(outcome.outcome === 'allow' ? outcome.changedFiles : []).toEqual(['src/app.ts']);
    expect(existsSync(join(projectDir, 'src', 'app.ts'))).toBe(false);
  });

  it('records on the ledger what each promoted file holds once it lands', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-record');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
    });

    expect(outcome.outcome).toBe('allow');
    const entry = readEvidenceLedger({ projectDir, sessionId: 'sess-gate' })?.tasks[0];
    expect(entry?.promotedFiles).toEqual([
      { path: 'src/app.ts', sha256: sha256Hex('worker\n'), mode: expect.any(Number) },
    ]);
  });

  it('records a promoted deletion as a file with no digest', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-record');
    rmSync(join(workspace.projectDir, 'src', 'app.ts'));

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
    });

    const entry = readEvidenceLedger({ projectDir, sessionId: 'sess-gate' })?.tasks[0];
    expect(entry?.promotedFiles).toEqual([{ path: 'src/app.ts', sha256: null, mode: null }]);
  });

  it('conflicts on a post-acquisition user edit with approval enabled', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-baseline');
    writeFileSync(join(projectDir, 'src', 'app.ts'), 'user edit\n');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
      callbacks: makeCallbacks({
        onTieredApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
      }).callbacks,
      config: makeNoValidationConfig({
        approval: { enabled: true, feedRejectionsToPlanner: false },
      }),
    });

    expect(outcome.outcome).toBe('promote-conflict');
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
  });

  it('promotes nothing when the workspace carries no acquisition baseline', async () => {
    const { projectDir, workspace, taskStartSnapshot } = await acquiredProject('gate-baseline');

    const task = makeTask({ id: 'T010', file: 'src/app.ts' });
    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace: { ...workspace, targetBaseline: undefined },
      taskStartSnapshot,
    });

    expect(outcome.outcome).toBe('promote-conflict');
    expect(outcome.outcome === 'promote-conflict' ? outcome.conflictedFiles : []).toEqual([
      'src/app.ts',
    ]);
    expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('original\n');
  });

  it('neither prompts for nor attributes checkout edits when the isolated worker changed nothing', async () => {
    const projectDir = createTempDir('gate-promote-project');
    dirs.push(projectDir);

    createTestGitRepo(projectDir, { 'docs/guide.md': 'before\n' });

    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const workspace = await createStagedProject({ projectDir: projectDir });
    dirs.push(workspace.projectDir);

    // The operator edits the checkout while the worker's call runs; the worker
    // leaves its workspace untouched.
    writeFileSync(join(projectDir, 'docs', 'guide.md'), 'operator edit\n');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'user.ts'), 'export const user = "after";\n');

    const task = makeTask({ id: 'T010', file: 'src/main.ts' });
    const onTieredApproval = vi.fn().mockResolvedValue({ decision: 'deny', reason: 'test' });
    const onApproved = vi.fn();

    const outcome = await runGate({
      task,
      state: makeImplState([task]),
      projectDir,
      workspace,
      taskStartSnapshot,
      callbacks: makeCallbacks({ onTieredApproval }).callbacks,
      config: makeNoValidationConfig({
        approval: { enabled: true, feedRejectionsToPlanner: false },
      }),
      onApproved,
    });

    expect(outcome.outcome === 'allow' ? outcome.changedFiles : undefined).toEqual([]);
    expect(onTieredApproval).not.toHaveBeenCalled();
    expect(onApproved).not.toHaveBeenCalled();
    expect(readFileSync(join(projectDir, 'docs', 'guide.md'), 'utf-8')).toBe('operator edit\n');
    expect(readFileSync(join(projectDir, 'src', 'user.ts'), 'utf-8')).toBe(
      'export const user = "after";\n',
    );
  });
});
