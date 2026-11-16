import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAttemptBrief } from '#testing/helpers/factories/attempt-brief.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { sessionDir, SPLITBRIEF_DIR } from '../../../core/paths.js';
import type { Config } from '../../../core/schemas/config.js';
import { saveState } from '../../../core/state/persistence.js';
import { clearBridgedCliState } from '../../runners/sandbox/state/bridge.js';
import { sandboxRoot, sandboxTempDir } from '../../runners/sandbox/state/paths.js';
import * as keptWork from '../kept-work.js';
import { applyRecoveryAction } from '../recovery/actions/apply.js';
import * as acquisition from './acquisition.js';
import { createRunIsolation } from './create.js';
import * as entrySnapshot from './entry-snapshot.js';
import type { AttemptWorkspace, RunIsolation } from './types.js';
import { removeRunWorkspace } from './worktree/remove.js';

const SESSION_ID = '2026-11-15-isolation-sign-in-test';

/** Command Code gets a copy of its sign-in file; Codex renews its sign-in, so it gets a link. */
const SIGN_IN = {
  'command-code': {
    file: join('.commandcode', 'auth.json'),
    content: '{"apiKey":"sign-in-fixture-key"}\n',
    kind: 'file',
  },
  codex: {
    file: join('.codex', 'auth.json'),
    content: '{"tokens":{"refresh_token":"sign-in-fixture-refresh"}}\n',
    kind: 'link',
  },
} as const;
type SignInTool = keyof typeof SIGN_IN;

const dirs: string[] = [];
let home = '';

beforeEach(() => {
  // The sandbox temp folders and a resumed sandbox root sit in the system temp folder; keep them in the test's own.
  const temp = createTempDir('isolation-sign-in-tmp');
  dirs.push(temp);
  vi.stubEnv('TMPDIR', temp);
  home = createTempDir('isolation-sign-in-home');
  const stateHome = createTempDir('isolation-sign-in-state');
  dirs.push(home, stateHome);
  for (const { file, content } of Object.values(SIGN_IN)) {
    mkdirSync(join(home, dirname(file)), { recursive: true });
    writeFileSync(join(home, file), content);
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_STATE_HOME', stateHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function project(): string {
  const dir = createTempDir('isolation-sign-in');
  dirs.push(dir);
  createTestGitRepo(dir, { 'README.md': '# test\n', '.gitignore': 'node_modules/\n' });
  return dir;
}

function seats(tool: SignInTool): Config {
  const config = createDefaultConfig();
  config.implementer = { kind: 'cli', tool };
  config.planner = { kind: 'cli', tool };
  return config;
}

function isolate(dir: string): RunIsolation {
  return createRunIsolation({
    projectDir: dir,
    sessionId: SESSION_ID,
    strategy: 'staged-copy',
    onFallback: () => {},
  });
}

function seated(handle: RunIsolation, config: Config): Promise<AttemptWorkspace[]> {
  return Promise.all(
    (['implementer', 'planner'] as const).map((role) =>
      handle.acquire({ role, config, brief: makeAttemptBrief() }),
    ),
  );
}

function signInOf(attempt: AttemptWorkspace, tool: SignInTool): string {
  return join(attempt.sandboxEnv.HOME ?? '', SIGN_IN[tool].file);
}

function kindOf(path: string): 'file' | 'link' | 'absent' {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 'absent';
  return stat.isSymbolicLink() ? 'link' : 'file';
}

/** Moves the run's staged root or leaf aside and puts a folder of another owner in its place. */
function replace(workspace: string, part: 'root' | 'leaf', kind: 'symlink' | 'directory'): string {
  const replaced = part === 'root' ? dirname(workspace) : workspace;
  renameSync(replaced, `${replaced}-owned`);
  let foreign = replaced;
  if (kind === 'directory') mkdirSync(replaced);
  else {
    foreign = createTempDir('isolation-sign-in-foreign');
    dirs.push(foreign);
    symlinkSync(foreign, replaced, 'dir');
  }
  return part === 'root' ? join(foreign, 'workspace') : foreign;
}

/** Files at the sign-in destinations of the implementer sandbox in `workspace`. */
function plantSignIns(workspace: string): string[] {
  const file = SIGN_IN['command-code'].file;
  const files = [
    join(sandboxRoot(workspace, 'implementer'), 'home', file),
    join(sandboxRoot(workspace, 'implementer', 'command-code'), 'home', file),
  ];
  for (const path of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'foreign bytes');
  }
  return files;
}

/** The run teardown clears the project sandbox, then disposes the run isolation. */
async function endRun(dir: string, handle: RunIsolation): Promise<void> {
  await clearBridgedCliState(dir);
  await handle.dispose();
}

const PARTIAL = 'partial.ts';

/**
 * The BUILD seat of T001 went down: the run kept its attempt, with one partial file when `partial`,
 * and the halt that it saved offers Skip.
 */
async function seatDownHalt(dir: string, config: Config, partial = true) {
  const task = makeTask({ id: 'T001', status: 'in_progress' });
  const handle = isolate(dir);
  const opened = await handle.open({ config });
  const attempt = await handle.acquire({
    role: 'implementer',
    config,
    brief: { ...makeAttemptBrief(), task },
  });
  if (partial) writeFileSync(join(opened.projectDir, PARTIAL), 'export const partial = true;\n');
  await attempt.retain?.();
  await endRun(dir, handle);
  const state = makeImplState([task], {
    workspace: {
      kind: 'staged-copy',
      path: opened.projectDir,
      base: { snapshotId: 'seat-down', head: null },
    },
    changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: attempt.snapshot },
    pendingRecovery: makeRecoveryIssue({ reason: 'runner-usage-limit', phase: 'implementing' }),
  });
  saveState({ projectDir: dir, sessionId: SESSION_ID }, state);
  return { state, attempt, workspace: opened.projectDir };
}

describe('run isolation sign-in state of a staged copy', () => {
  it.each(Object.keys(SIGN_IN) as SignInTool[])(
    'the end of a run removes the %s sign-in and the temp folder of each seat, and a later run builds the sign-in again',
    async (tool) => {
      const dir = project();
      const config = seats(tool);
      const first = isolate(dir);
      const opened = await first.open({ config });
      const attempts = await seated(first, config);
      const signIns = attempts.map((attempt) => signInOf(attempt, tool));
      const temps = attempts.map((attempt) => attempt.sandboxEnv.TMPDIR ?? '');

      expect(opened.kind).toBe('staged-copy');
      expect(signIns.map(kindOf)).toEqual([SIGN_IN[tool].kind, SIGN_IN[tool].kind]);
      for (const signIn of signIns)
        expect(signIn.startsWith(join(opened.projectDir, SPLITBRIEF_DIR, 'sandbox'))).toBe(true);
      expect(temps.map(existsSync)).toEqual([true, true]);

      await endRun(dir, first);

      expect(signIns.map(kindOf)).toEqual(['absent', 'absent']);
      expect(temps.map(existsSync)).toEqual([false, false]);
      expect(existsSync(opened.projectDir)).toBe(true);
      expect(readFileSync(join(home, SIGN_IN[tool].file), 'utf8')).toBe(SIGN_IN[tool].content);

      const later = isolate(dir);
      const reopened = await later.open({ config });
      const [again] = await seated(later, config);
      if (again === undefined) throw new Error('the later run got no attempt');

      expect(reopened.projectDir).toBe(opened.projectDir);
      expect(signInOf(again, tool)).toBe(signIns[0]);
      expect(kindOf(signInOf(again, tool))).toBe(SIGN_IN[tool].kind);

      await endRun(dir, later);

      expect(kindOf(signInOf(again, tool))).toBe('absent');
    },
  );

  it('a stopped run keeps the sign-in of its staged copy, also when the open of a later run fails', async () => {
    const dir = project();
    const config = seats('command-code');
    const stopped = isolate(dir);
    await stopped.open({ config });
    const attempt = await stopped.acquire({
      role: 'implementer',
      config,
      brief: makeAttemptBrief(),
    });
    const signIn = signInOf(attempt, 'command-code');
    await attempt.retain?.();
    await endRun(dir, stopped);

    expect(kindOf(signIn)).toBe('file');

    const fault = new Error('the sign-in fixture fails the open');
    vi.spyOn(acquisition, 'prepareWorktreeAcquisition').mockRejectedValueOnce(fault);
    const later = isolate(dir);
    await expect(later.open({ config })).rejects.toBe(fault);
    await endRun(dir, later);

    expect(kindOf(signIn)).toBe('file');
  });

  it('a run that Continue takes to the end removes the sign-in and the temp folder that its stop kept', async () => {
    const dir = project();
    const config = seats('command-code');
    const stopped = isolate(dir);
    await stopped.open({ config });
    const attempt = await stopped.acquire({
      role: 'implementer',
      config,
      brief: makeAttemptBrief(),
    });
    const signIn = signInOf(attempt, 'command-code');
    const temp = attempt.sandboxEnv.TMPDIR ?? '';
    await attempt.retain?.();
    await endRun(dir, stopped);

    expect(kindOf(signIn)).toBe('file');
    expect(existsSync(temp)).toBe(true);

    const continued = isolate(dir);
    await continued.open({ config });
    const resumed = await continued.acquire({
      role: 'implementer',
      config,
      brief: makeAttemptBrief(),
      resume: true,
    });
    const resumedHome = resumed.sandboxEnv.HOME ?? '';
    expect(existsSync(resumedHome)).toBe(true);
    await endRun(dir, continued);

    expect(kindOf(signIn)).toBe('absent');
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(resumedHome)).toBe(false);
  });

  it('a stopped run that End run closes leaves no temp folder of its staged copy', async () => {
    const dir = project();
    const config = seats('command-code');
    const stopped = isolate(dir);
    const opened = await stopped.open({ config });
    const planner = await stopped.acquire({ role: 'planner', config, brief: makeAttemptBrief() });
    const implementer = await stopped.acquire({
      role: 'implementer',
      config,
      brief: makeAttemptBrief(),
    });
    const temps = [planner, implementer].map((attempt) => attempt.sandboxEnv.TMPDIR ?? '');
    await implementer.retain?.();
    await endRun(dir, stopped);

    expect(temps.map(existsSync)).toEqual([true, true]);

    expect(
      await removeRunWorkspace(dir, SESSION_ID, { kind: 'staged-copy', path: opened.projectDir }),
    ).toBeNull();

    expect(existsSync(opened.projectDir)).toBe(false);
    expect(temps.map(existsSync)).toEqual([false, false]);
  });

  it.each([
    { partial: true, wrote: 'after a partial file' },
    { partial: false, wrote: 'before any file' },
  ])(
    'a Skip of the brief whose seat went down $wrote ends its keep, so a run that ends with no later brief removes the sign-in and the temp folder',
    async ({ partial }) => {
      const dir = project();
      const config = seats('command-code');
      const { state, attempt, workspace } = await seatDownHalt(dir, config, partial);
      const signIn = signInOf(attempt, 'command-code');
      const temp = attempt.sandboxEnv.TMPDIR ?? '';
      expect(kindOf(signIn)).toBe('file');

      const skipped = await applyRecoveryAction({
        projectDir: dir,
        sessionId: SESSION_ID,
        state,
        action: 'skip-current-task',
        bus: makeBusRecorder().bus,
      });

      expect(skipped.ok).toBe(true);
      expect(existsSync(join(workspace, PARTIAL))).toBe(false);

      const last = isolate(dir);
      await last.open({ config });
      await endRun(dir, last);

      expect(kindOf(signIn)).toBe('absent');
      expect(existsSync(temp)).toBe(false);
    },
  );

  it('a Skip whose put-back failed keeps the stopped attempt, so the next brief puts its file back', async () => {
    const dir = project();
    const config = seats('command-code');
    const { state, workspace } = await seatDownHalt(dir, config);
    vi.spyOn(entrySnapshot, 'restoreWorkspaceFiles').mockRejectedValueOnce(
      new Error('the fixture fails the put-back'),
    );
    const { bus, events } = makeBusRecorder();

    const skipped = await applyRecoveryAction({
      projectDir: dir,
      sessionId: SESSION_ID,
      state,
      action: 'skip-current-task',
      bus,
    });

    expect(skipped.ok).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('Failed to restore the changes of the failing brief'),
      }),
    );
    expect(existsSync(join(workspace, PARTIAL))).toBe(true);

    const next = isolate(dir);
    await next.open({ config });
    await next.acquire({
      role: 'implementer',
      config,
      brief: { ...makeAttemptBrief(), task: makeTask({ id: 'T002' }) },
    });

    expect(existsSync(join(workspace, PARTIAL))).toBe(false);
    await endRun(dir, next);
  });

  it('a Skip whose start cannot be compared keeps the stopped attempt, so the next brief puts its file back', async () => {
    const dir = project();
    const config = seats('command-code');
    const { state, workspace } = await seatDownHalt(dir, config);
    vi.spyOn(entrySnapshot, 'restoreWorkspaceFiles').mockRejectedValueOnce(
      new Error('the fixture cannot compare the start'),
    );
    const kept = vi.spyOn(keptWork, 'briefKeptFiles').mockResolvedValue(undefined);

    const skipped = await applyRecoveryAction({
      projectDir: dir,
      sessionId: SESSION_ID,
      state,
      action: 'skip-current-task',
      bus: makeBusRecorder().bus,
    });
    kept.mockRestore();

    expect(skipped.ok).toBe(true);
    expect(existsSync(join(workspace, PARTIAL))).toBe(true);

    const next = isolate(dir);
    await next.open({ config });
    await next.acquire({
      role: 'implementer',
      config,
      brief: { ...makeAttemptBrief(), task: makeTask({ id: 'T002' }) },
    });

    expect(existsSync(join(workspace, PARTIAL))).toBe(false);
    await endRun(dir, next);
  });

  it('the end of a run whose open failed after the copy removes the sign-in and the temp folder of the staged copy', async () => {
    const dir = project();
    const config = seats('command-code');
    const fault = new Error('the sign-in fixture fails the open');
    vi.spyOn(acquisition, 'prepareWorktreeAcquisition').mockRejectedValueOnce(fault);
    const handle = isolate(dir);

    await expect(handle.open({ config })).rejects.toBe(fault);
    const leaves = readdirSync(sessionDir(dir, SESSION_ID)).filter((name) =>
      name.startsWith('stage-'),
    );
    const leaf = leaves[0];
    if (leaves.length !== 1 || leaf === undefined) throw new Error('the open left no staged copy');
    const workspace = join(sessionDir(dir, SESSION_ID), leaf, 'workspace');
    const root = sandboxRoot(workspace, 'implementer', 'command-code');
    const signIn = join(root, 'home', SIGN_IN['command-code'].file);
    expect(kindOf(signIn)).toBe('file');
    expect(existsSync(sandboxTempDir(root))).toBe(true);

    await endRun(dir, handle);

    expect(kindOf(signIn)).toBe('absent');
    expect(existsSync(sandboxTempDir(root))).toBe(false);
    expect(existsSync(workspace)).toBe(true);
  });

  it('the end of a run after Apply removed its staged copy succeeds and removes the temp folder of each seat', async () => {
    const dir = project();
    const config = seats('command-code');
    const handle = isolate(dir);
    const opened = await handle.open({ config });
    const temps = (await seated(handle, config)).map((attempt) => attempt.sandboxEnv.TMPDIR ?? '');
    expect(temps.map(existsSync)).toEqual([true, true]);

    expect(
      await removeRunWorkspace(dir, SESSION_ID, { kind: 'staged-copy', path: opened.projectDir }),
    ).toBeNull();
    expect(existsSync(opened.projectDir)).toBe(false);

    await expect(endRun(dir, handle)).resolves.toBeUndefined();

    expect(temps.map(existsSync)).toEqual([false, false]);
  });

  it.each([
    { part: 'root', kind: 'symlink', ended: 'Refusing to read through symlink' },
    { part: 'root', kind: 'directory', ended: 'ended' },
    { part: 'leaf', kind: 'symlink', ended: 'ended' },
    { part: 'leaf', kind: 'directory', ended: 'ended' },
  ] as const)(
    'the end of a run whose staged $part was replaced by a $kind keeps the sign-in files of that folder',
    async ({ part, kind, ended }) => {
      const dir = project();
      const config = seats('command-code');
      const handle = isolate(dir);
      const opened = await handle.open({ config });
      await handle.acquire({ role: 'implementer', config, brief: makeAttemptBrief() });
      const foreign = plantSignIns(replace(opened.projectDir, part, kind));

      const outcome = await endRun(dir, handle).then(
        () => 'ended',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      expect(outcome).toContain(ended);
      expect(foreign.map((path) => readFileSync(path, 'utf8'))).toEqual([
        'foreign bytes',
        'foreign bytes',
      ]);
    },
  );
});
