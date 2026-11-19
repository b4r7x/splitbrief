import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAttemptBrief } from '#testing/helpers/factories/attempt-brief.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { isolationWorktreePath, sessionDir, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { IsolationStrategy } from '../../../core/schemas/enums.js';
import * as formatErrors from '../../../utils/format/errors.js';
import * as sandboxEnv from '../../runners/sandbox/env.js';
import * as bridge from '../../runners/sandbox/state/bridge.js';
import * as sandboxPaths from '../../runners/sandbox/state/paths.js';
import * as stagedProject from '../approval/staged-project/create.js';
import { withAttemptRestoreScope } from '../task/restore-scope.js';
import * as acquisition from './acquisition.js';
import { createRunIsolation } from './create.js';
import * as entrySnapshot from './entry-snapshot.js';
import * as retention from './retention.js';
import * as sandboxEnvs from './sandbox-env.js';
import * as ensure from './worktree/ensure.js';
import * as nodeModules from './worktree/node-modules.js';
import * as worktreeRemoval from './worktree/remove.js';

const SESSION_ID = '2026-11-15-isolation-lifecycle-test';
const config = createDefaultConfig();
const REAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
const UNAVAILABLE = { kind: 'isolation-retention-unavailable' };

const real = {
  ensureIsolationWorktree: ensure.ensureIsolationWorktree,
  createStagedProject: stagedProject.createStagedProject,
  addWorkspaceRoot: formatErrors.addWorkspaceRoot,
  retainWorkspaceRecord: retention.retainWorkspaceRecord,
  prepareWorktreeAcquisition: acquisition.prepareWorktreeAcquisition,
  captureWorkspaceSnapshot: entrySnapshot.captureWorkspaceSnapshot,
  restoreWorkspaceFiles: entrySnapshot.restoreWorkspaceFiles,
  createWorkspaceSandboxEnvs: sandboxEnvs.createWorkspaceSandboxEnvs,
  pruneSandboxNpmCache: sandboxEnv.pruneSandboxNpmCache,
  removeSandboxTempDirs: sandboxPaths.removeSandboxTempDirs,
  clearBridgedCliState: bridge.clearBridgedCliState,
  removeWorktree: worktreeRemoval.removeWorktree,
  removeNodeModulesExclude: nodeModules.removeNodeModulesExclude,
};

const dirs: string[] = [];

beforeEach(() => {
  const stateHome = createTempDir('isolation-lifecycle-state');
  dirs.push(stateHome);
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  if (REAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = REAL_XDG_STATE_HOME;
});

function project(files: Record<string, string>, options: { nodeModules?: boolean } = {}): string {
  const dir = createTempDir('isolation-lifecycle');
  dirs.push(dir);
  createTestGitRepo(dir, { 'README.md': '# test\n', ...files });
  if (options.nodeModules === true) mkdirSync(join(dir, 'node_modules'));
  return dir;
}

function worktreeOf(dir: string): string {
  return isolationWorktreePath(realpathSync(join(dir, '.git')), SESSION_ID.slice(0, 64));
}

/** Names a path by its role in the run, so one log reads the same in every temp folder. */
function who(dir: string, path: string): string {
  if (path === dir || path === realpathSync(dir)) return 'project';
  if (existsSync(join(dir, '.git')) && path === worktreeOf(dir)) return 'worktree';
  if (path === sessionDir(dir, SESSION_ID)) return 'checkout sandbox';
  if (path.startsWith(join(sessionDir(dir, SESSION_ID), 'stage-'))) return 'staged copy';
  if (basename(path).startsWith('splitbrief-resume-env-')) return 'resumed env';
  return path;
}

/** Logs each step that creates or removes a part of the run workspace, in the order it runs. */
function logSteps(dir: string): string[] {
  const log: string[] = [];
  vi.spyOn(ensure, 'ensureIsolationWorktree').mockImplementation((opts) =>
    real.ensureIsolationWorktree({
      ...opts,
      onWorktreeCreated: (path) => {
        log.push(`create worktree ${who(dir, path)}`);
        opts.onWorktreeCreated?.(path);
      },
      onNodeModulesExcluded: (file) => {
        log.push('add exclude');
        opts.onNodeModulesExcluded?.(file);
      },
    }),
  );
  vi.spyOn(stagedProject, 'createStagedProject').mockImplementation(async (input) => {
    log.push('create staged copy');
    return real.createStagedProject(input);
  });
  vi.spyOn(formatErrors, 'addWorkspaceRoot').mockImplementation((root) => {
    log.push(`add root ${who(dir, root)}`);
    const remove = real.addWorkspaceRoot(root);
    return () => {
      log.push(`remove root ${who(dir, root)}`);
      remove();
    };
  });
  vi.spyOn(retention, 'retainWorkspaceRecord').mockImplementation(async (ref, input) => {
    log.push(input.retained === true ? 'save retained record' : 'save record');
    await real.retainWorkspaceRecord(ref, input);
  });
  vi.spyOn(acquisition, 'prepareWorktreeAcquisition').mockImplementation(async (opts) => {
    log.push(`baseline ${who(dir, opts.worktreeDir)}`);
    return real.prepareWorktreeAcquisition(opts);
  });
  vi.spyOn(entrySnapshot, 'captureWorkspaceSnapshot').mockImplementation(
    async (workspace, ref, onEmbeddedRepo) => {
      log.push(`snapshot ${who(dir, workspace)}`);
      return real.captureWorkspaceSnapshot(workspace, ref, onEmbeddedRepo);
    },
  );
  vi.spyOn(entrySnapshot, 'restoreWorkspaceFiles').mockImplementation(async (input) => {
    log.push(`put back ${who(dir, input.dir)}`);
    return real.restoreWorkspaceFiles(input);
  });
  vi.spyOn(sandboxEnvs, 'createWorkspaceSandboxEnvs').mockImplementation(() => {
    const envs = real.createWorkspaceSandboxEnvs();
    return {
      ...envs,
      removeResumedRoots: async () => {
        log.push('remove resumed envs');
        await envs.removeResumedRoots();
      },
    };
  });
  vi.spyOn(sandboxEnv, 'pruneSandboxNpmCache').mockImplementation(async (path) => {
    log.push(`prune npm cache ${who(dir, path)}`);
    await real.pruneSandboxNpmCache(path);
  });
  vi.spyOn(sandboxPaths, 'removeSandboxTempDirs').mockImplementation((path) => {
    log.push(`remove temp dirs ${who(dir, path)}`);
    real.removeSandboxTempDirs(path);
  });
  vi.spyOn(bridge, 'clearBridgedCliState').mockImplementation(async (path, tool) => {
    log.push(`clear sign-in copies ${who(dir, path)}`);
    await real.clearBridgedCliState(path, tool);
  });
  vi.spyOn(worktreeRemoval, 'removeWorktree').mockImplementation(async (opts) => {
    log.push(`remove worktree ${who(dir, opts.worktreeDir ?? opts.slug)}`);
    return real.removeWorktree(opts);
  });
  vi.spyOn(nodeModules, 'removeNodeModulesExclude').mockImplementation(async (file, id) => {
    log.push('remove exclude');
    await real.removeNodeModulesExclude(file, id);
  });
  return log;
}

function isolate(dir: string, strategy: IsolationStrategy, log: string[]) {
  return createRunIsolation({
    projectDir: dir,
    sessionId: SESSION_ID,
    strategy,
    onFallback: () => log.push('fall back'),
    infoPublisher: (row) => log.push(`row ${row.message.split('.')[0]}`),
  });
}

function attempt(handle: ReturnType<typeof createRunIsolation>) {
  return handle.acquire({ role: 'implementer', config, brief: makeAttemptBrief() });
}

function excludeText(dir: string): string {
  const file = join(dir, '.git', 'info', 'exclude');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function worktreeList(dir: string): string {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
}

/** Every file of the project outside git's and SPLITBRIEF's own folders, by its content hash. */
function projectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name).slice(dir.length + 1);
    if (file.startsWith('.git/') || file.startsWith(`${SPLITBRIEF_DIR}/`)) continue;
    files[file] = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
  }
  return files;
}

const OPEN_WORKTREE = [
  'create worktree worktree',
  'add exclude',
  'baseline worktree',
  'snapshot worktree',
  'add root worktree',
  'save record',
];
const ATTEMPT_WORKTREE = ['baseline worktree', 'snapshot worktree', 'save record'];
const DISPOSE_WORKTREE = [
  'clear sign-in copies checkout sandbox',
  'prune npm cache checkout sandbox',
  'remove temp dirs checkout sandbox',
  'clear sign-in copies worktree',
  'remove temp dirs worktree',
  'remove root worktree',
  'remove resumed envs',
  'remove exclude',
];

describe('run isolation lifecycle', () => {
  it('a normal close keeps the worktree, removes what the run added once, and refuses every later call', async () => {
    const dir = project({ '.gitignore': 'node_modules/\n' }, { nodeModules: true });
    const excludeBefore = excludeText(dir);
    const log = logSteps(dir);
    const handle = isolate(dir, 'worktree', log);

    const opened = await handle.open({ config });
    const first = await attempt(handle);
    expect(excludeText(dir)).toContain(SESSION_ID);
    first.cleanup();
    await handle.dispose();
    await handle.dispose();

    expect(log).toEqual([
      ...OPEN_WORKTREE,
      ...ATTEMPT_WORKTREE,
      'put back worktree',
      ...DISPOSE_WORKTREE,
    ]);
    expect(opened.projectDir).toBe(worktreeOf(dir));
    expect(existsSync(worktreeOf(dir))).toBe(true);
    expect(worktreeList(dir)).toContain(worktreeOf(dir));
    expect(excludeText(dir)).toBe(excludeBefore);

    const closed = [...log];
    await expect(handle.open({ config })).rejects.toMatchObject(UNAVAILABLE);
    await expect(attempt(handle)).rejects.toMatchObject(UNAVAILABLE);
    await expect(first.revert()).rejects.toMatchObject(UNAVAILABLE);
    await expect(first.discard(['README.md'])).rejects.toMatchObject(UNAVAILABLE);
    await expect(first.retain?.()).rejects.toMatchObject(UNAVAILABLE);
    await handle.dispose();
    expect(log).toEqual(closed);
  });

  it('removes a worktree the open abandoned once at dispose, and the run works in one staged copy', async () => {
    const dir = project({}, { nodeModules: true });
    const log = logSteps(dir);
    const handle = isolate(dir, 'worktree', log);

    const opened = await handle.open({ config });
    const first = await attempt(handle);
    first.cleanup();
    await handle.dispose();
    await handle.dispose();

    expect(opened.kind).toBe('staged-copy');
    expect(log).toEqual([
      'create worktree worktree',
      'fall back',
      'create staged copy',
      'baseline staged copy',
      'snapshot staged copy',
      'add root staged copy',
      'save record',
      'baseline staged copy',
      'snapshot staged copy',
      'save record',
      'put back staged copy',
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'clear sign-in copies worktree',
      'remove temp dirs worktree',
      'remove worktree worktree',
      'clear sign-in copies staged copy',
      'remove temp dirs staged copy',
      'remove root staged copy',
      'remove resumed envs',
    ]);
    expect(existsSync(worktreeOf(dir))).toBe(false);
    expect(worktreeList(dir)).not.toContain(worktreeOf(dir));
    expect(existsSync(opened.projectDir)).toBe(true);
  });

  it('an open that fails before it registers the workspace removes only what it made, and every attempt gets its refusal', async () => {
    const dir = project({ '.gitignore': 'node_modules/\n' }, { nodeModules: true });
    const excludeBefore = excludeText(dir);
    const log = logSteps(dir);
    const fault = new Error('the lifecycle fixture fails the open');
    vi.mocked(acquisition.prepareWorktreeAcquisition).mockImplementationOnce(async (opts) => {
      log.push(`baseline ${who(dir, opts.worktreeDir)}`);
      throw fault;
    });
    const handle = isolate(dir, 'worktree', log);

    await expect(handle.open({ config })).rejects.toBe(fault);
    await expect(attempt(handle)).rejects.toBe(fault);
    await handle.dispose();
    await handle.dispose();

    expect(log).toEqual([
      'create worktree worktree',
      'add exclude',
      'baseline worktree',
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'clear sign-in copies worktree',
      'remove temp dirs worktree',
      'remove resumed envs',
      'remove exclude',
    ]);
    expect(existsSync(worktreeOf(dir))).toBe(true);
    expect(excludeText(dir)).toBe(excludeBefore);
  });

  it.each([
    {
      call: 'open',
      steps: [
        'create worktree worktree',
        'baseline worktree',
        'snapshot worktree',
        'add root worktree',
        'open refused isolation-retention-unavailable',
      ],
    },
    {
      call: 'acquire',
      steps: [
        'create worktree worktree',
        'baseline worktree',
        'snapshot worktree',
        'add root worktree',
        'save record',
        'baseline worktree',
        'snapshot worktree',
        'acquire refused isolation-retention-unavailable',
      ],
    },
  ] as const)(
    'a dispose while the $call is in flight waits for it before it removes anything',
    async ({ call, steps }) => {
      const dir = project({});
      const log = logSteps(dir);
      const handle = isolate(dir, 'worktree', log);
      if (call === 'acquire') await handle.open({ config });
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.mocked(entrySnapshot.captureWorkspaceSnapshot).mockImplementationOnce(
        async (workspace, ref, onEmbeddedRepo) => {
          log.push(`snapshot ${who(dir, workspace)}`);
          held.resolve();
          await release.promise;
          return real.captureWorkspaceSnapshot(workspace, ref, onEmbeddedRepo);
        },
      );

      const inFlight = (call === 'open' ? handle.open({ config }) : attempt(handle)).then(
        () => log.push(`${call} resolved`),
        (err: unknown) =>
          log.push(`${call} refused ${err instanceof Error && 'kind' in err ? err.kind : err}`),
      );
      await held.promise;
      const disposing = handle.dispose();
      release.resolve();
      await disposing;
      await inFlight;

      expect(log).toEqual([
        ...steps,
        'clear sign-in copies checkout sandbox',
        'prune npm cache checkout sandbox',
        'remove temp dirs checkout sandbox',
        'clear sign-in copies worktree',
        'remove temp dirs worktree',
        'remove root worktree',
        'remove resumed envs',
      ]);
    },
  );

  it('puts a failed attempt back before dispose removes anything', async () => {
    const dir = project({ 'src.txt': 'v1\n' });
    const log = logSteps(dir);
    const handle = isolate(dir, 'worktree', log);

    const first = await attempt(handle);
    writeFileSync(join(first.projectDir, 'src.txt'), 'attempt\n');
    writeFileSync(join(first.projectDir, 'attempt.txt'), 'attempt\n');
    first.cleanup();
    await handle.dispose();

    expect(log).toEqual([
      'create worktree worktree',
      'baseline worktree',
      'snapshot worktree',
      'add root worktree',
      'save record',
      ...ATTEMPT_WORKTREE,
      'put back worktree',
      `row ${makeAttemptBrief().task.id} attempt reverted: 2 files`,
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'clear sign-in copies worktree',
      'remove temp dirs worktree',
      'remove root worktree',
      'remove resumed envs',
    ]);
    expect(readFileSync(join(worktreeOf(dir), 'src.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(worktreeOf(dir), 'attempt.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'src.txt'), 'utf8')).toBe('v1\n');
  });

  it('refuses the next attempt after a put-back fails, and dispose still removes everything once', async () => {
    const dir = project({ 'src.txt': 'v1\n' });
    const log = logSteps(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(entrySnapshot.restoreWorkspaceFiles).mockImplementationOnce(async (input) => {
      log.push(`put back ${who(dir, input.dir)}`);
      throw new Error('the lifecycle fixture fails the put-back');
    });
    const handle = isolate(dir, 'worktree', log);

    const first = await attempt(handle);
    writeFileSync(join(first.projectDir, 'attempt.txt'), 'kept\n');
    first.cleanup();
    await expect(attempt(handle)).rejects.toMatchObject({ kind: 'isolation-cleanup-failed' });
    await handle.dispose();

    expect(log).toEqual([
      'create worktree worktree',
      'baseline worktree',
      'snapshot worktree',
      'add root worktree',
      'save record',
      ...ATTEMPT_WORKTREE,
      'put back worktree',
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'clear sign-in copies worktree',
      'remove temp dirs worktree',
      'remove root worktree',
      'remove resumed envs',
    ]);
    expect(readFileSync(join(worktreeOf(dir), 'attempt.txt'), 'utf8')).toBe('kept\n');
  });

  it('a revert puts back only its own attempt, and a replaced attempt can neither clean up nor revert', async () => {
    const dir = project({ 'src.txt': 'v1\n' });
    const log = logSteps(dir);
    const handle = isolate(dir, 'worktree', log);

    const first = await attempt(handle);
    writeFileSync(join(first.projectDir, 'src.txt'), 'first\n');
    const second = await attempt(handle);
    writeFileSync(join(second.projectDir, 'second.txt'), 'second\n');
    await second.revert();
    first.cleanup();
    await expect(first.revert()).rejects.toMatchObject(UNAVAILABLE);
    await expect(first.discard(['src.txt'])).rejects.toMatchObject(UNAVAILABLE);
    await handle.dispose();

    expect(log).toEqual([
      'create worktree worktree',
      'baseline worktree',
      'snapshot worktree',
      'add root worktree',
      'save record',
      ...ATTEMPT_WORKTREE,
      ...ATTEMPT_WORKTREE,
      'put back worktree',
      `row ${makeAttemptBrief().task.id} attempt reverted: 1 file`,
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'clear sign-in copies worktree',
      'remove temp dirs worktree',
      'remove root worktree',
      'remove resumed envs',
    ]);
    expect(readFileSync(join(worktreeOf(dir), 'src.txt'), 'utf8')).toBe('first\n');
    expect(existsSync(join(worktreeOf(dir), 'second.txt'))).toBe(false);
  });

  it('runs the final removals once when a dispose step throws, and a second dispose repeats nothing', async () => {
    const dir = project({ '.gitignore': 'node_modules/\n' }, { nodeModules: true });
    const excludeBefore = excludeText(dir);
    const log = logSteps(dir);
    const fault = new Error('the lifecycle fixture fails the dispose');
    vi.mocked(sandboxEnv.pruneSandboxNpmCache).mockImplementationOnce(async (path) => {
      log.push(`prune npm cache ${who(dir, path)}`);
      throw fault;
    });
    const handle = isolate(dir, 'worktree', log);

    await attempt(handle);
    await expect(handle.dispose()).rejects.toBe(fault);
    await expect(handle.dispose()).rejects.toBe(fault);

    expect(log).toEqual([
      ...OPEN_WORKTREE,
      ...ATTEMPT_WORKTREE,
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove root worktree',
      'remove resumed envs',
      'remove exclude',
    ]);
    expect(existsSync(worktreeOf(dir))).toBe(true);
    expect(excludeText(dir)).toBe(excludeBefore);
  });

  it('the checkout mode creates nothing, removes no file of the project, and keeps a retained partial', async () => {
    const dir = project(
      { 'src.txt': 'user\n', '.gitignore': 'node_modules/\n' },
      { nodeModules: true },
    );
    const filesBefore = projectFiles(dir);
    const excludeBefore = excludeText(dir);
    const worktreesBefore = worktreeList(dir);
    const log = logSteps(dir);
    const handle = isolate(dir, 'none', log);

    const opened = await handle.open({ config });
    const first = await attempt(handle);
    await withAttemptRestoreScope({
      ref: { projectDir: dir, sessionId: SESSION_ID },
      dir,
      taskStartSnapshot: first.snapshot,
      run: async () => {
        writeFileSync(join(dir, 'src.txt'), 'attempt\n');
        writeFileSync(join(dir, 'attempt.txt'), 'attempt\n');
      },
    });
    first.cleanup();
    const second = await attempt(handle);
    expect(projectFiles(dir)).toEqual(filesBefore);
    writeFileSync(join(dir, 'partial.txt'), 'partial\n');
    await second.retain?.();
    second.cleanup();
    await handle.dispose();
    await handle.dispose();

    expect(opened).toMatchObject({ kind: 'checkout', projectDir: dir });
    expect(log).toEqual([
      'snapshot project',
      'snapshot project',
      'put back project',
      `row ${makeAttemptBrief().task.id} attempt reverted: 2 files`,
      'snapshot project',
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove temp dirs checkout sandbox',
      'remove resumed envs',
    ]);
    expect(projectFiles(dir)).toEqual({
      ...filesBefore,
      'partial.txt': createHash('sha256').update('partial\n').digest('hex'),
    });
    expect(excludeText(dir)).toBe(excludeBefore);
    expect(worktreeList(dir)).toBe(worktreesBefore);
  });

  it('the checkout mode keeps every other project file through a revert, a discard and a dispose step that throws', async () => {
    const dir = project(
      { 'src.txt': 'user\n', 'other.txt': 'other\n', '.gitignore': 'node_modules/\n' },
      { nodeModules: true },
    );
    const filesBefore = projectFiles(dir);
    const excludeBefore = excludeText(dir);
    const worktreesBefore = worktreeList(dir);
    const log = logSteps(dir);
    const fault = new Error('the lifecycle fixture fails the dispose');
    vi.mocked(sandboxEnv.pruneSandboxNpmCache).mockImplementationOnce(async (path) => {
      log.push(`prune npm cache ${who(dir, path)}`);
      throw fault;
    });
    const handle = isolate(dir, 'none', log);
    const ref = { projectDir: dir, sessionId: SESSION_ID };

    const first = await attempt(handle);
    await withAttemptRestoreScope({
      ref,
      dir,
      taskStartSnapshot: first.snapshot,
      run: async () => {
        writeFileSync(join(dir, 'src.txt'), 'first\n');
        writeFileSync(join(dir, 'first.txt'), 'first\n');
      },
    });
    await first.revert();
    expect(projectFiles(dir)).toEqual(filesBefore);
    const second = await attempt(handle);
    await withAttemptRestoreScope({
      ref,
      dir,
      taskStartSnapshot: second.snapshot,
      run: async () => {
        writeFileSync(join(dir, 'src.txt'), 'second\n');
        writeFileSync(join(dir, 'kept.txt'), 'kept\n');
      },
    });
    await second.discard(['src.txt']);
    await expect(handle.dispose()).rejects.toBe(fault);
    await expect(handle.dispose()).rejects.toBe(fault);

    expect(log).toEqual([
      'snapshot project',
      'snapshot project',
      'put back project',
      `row ${makeAttemptBrief().task.id} attempt reverted: 2 files`,
      'snapshot project',
      'snapshot project',
      'put back project',
      'clear sign-in copies checkout sandbox',
      'prune npm cache checkout sandbox',
      'remove resumed envs',
    ]);
    expect(projectFiles(dir)).toEqual({
      ...filesBefore,
      'kept.txt': createHash('sha256').update('kept\n').digest('hex'),
    });
    expect(excludeText(dir)).toBe(excludeBefore);
    expect(worktreeList(dir)).toBe(worktreesBefore);
  });
});
