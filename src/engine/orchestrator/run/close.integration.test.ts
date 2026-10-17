import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { SPLITBRIEF_DIR, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { createSnapshot } from '../../snapshots/create.js';
import { recordRunSnapshot } from '../../snapshots/run/ledger.js';
import { markExited, writeLockfile } from '../../../core/sessions/lockfile.js';
import { recordLocalTaskEvidence } from '../evidence/task.js';
import { reconcileWorkspaceToBase } from '../isolation/acquisition.js';
import { createRunIsolation } from '../isolation/create.js';
import { captureWorkspaceSnapshot } from '../isolation/entry-snapshot.js';
import { finalizeRunAtRest } from '../session-lifecycle/finalize.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { runPlanApproval } from '../planning/session.js';
import { closeRunIfOpen, rejectCheckoutRun } from './close.js';

const removal = vi.hoisted(() => ({ patchExisted: [] as boolean[] }));
vi.mock('../isolation/remove-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../isolation/remove-worktree.js')>();
  return {
    ...actual,
    removeRunWorkspace: async (...args: Parameters<typeof actual.removeRunWorkspace>) => {
      removal.patchExisted.push(existsSync(join(sessionDir(args[0], args[1]), 'run.patch')));
      return actual.removeRunWorkspace(...args);
    },
  };
});

const SESSION_ID = '2026-10-04-close-run';
const BINARY = Buffer.from([0, 1, 2, 255, 0, 7]);
const realStateHome = process.env.XDG_STATE_HOME;
let dirs: string[] = [];

beforeEach(() => {
  removal.patchExisted = [];
  const stateHome = createTempDir('close-run-state-home');
  dirs.push(stateHome);
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  if (realStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = realStateHome;
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

async function openWorkspaceRun(strategy: 'worktree' | 'staged-copy') {
  const projectDir = createTempDir('close-run-');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, {
    'src/keep.ts': 'export const one = 1;\nexport const two = 2;\n',
    'src/gone.ts': 'export const gone = true;\n',
  });
  const ref = { projectDir, sessionId: SESSION_ID };
  ensureSessionDir(projectDir, SESSION_ID);
  await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const isolation = createRunIsolation({
    ...ref,
    strategy,
    onFallback: () => {},
  });
  const opened = await isolation.open({ config: createDefaultConfig() });
  await reconcileWorkspaceToBase({
    ...ref,
    snapshotId: base.manifest.id,
    workspaceDir: opened.projectDir,
    keep: opened.keptFiles,
  });
  await isolation.dispose();
  const workspaceDir = opened.projectDir;
  dirs.push(dirname(workspaceDir));
  writeFileSync(
    join(workspaceDir, 'src/keep.ts'),
    'export const one = 1;\nexport const two = 22;\n',
  );
  unlinkSync(join(workspaceDir, 'src/gone.ts'));
  writeFileSync(join(workspaceDir, 'src/new.ts'), 'export const fresh = "new";\n');
  mkdirSync(join(workspaceDir, 'assets'), { recursive: true });
  writeFileSync(join(workspaceDir, 'assets/logo.bin'), BINARY);
  const state: WorkflowState = {
    ...createInitialState('Close a workspace run'),
    phase: 'implementing',
    workspace: {
      kind: opened.kind,
      path: workspaceDir,
      base: { snapshotId: base.manifest.id, head: opened.head },
    },
  };
  saveState(ref, state);
  return { ref, state, workspaceDir, base };
}

/**
 * A checkout run inside its brief T001, which declares lib/lerp.mjs and has written it and an
 * undeclared test file since it started.
 */
async function checkoutRunInBrief() {
  const projectDir = createTempDir('close-run-checkout-brief-');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, { 'lib/clamp.mjs': 'export const clamp = 1;\n' });
  const ref = { projectDir, sessionId: SESSION_ID };
  ensureSessionDir(projectDir, SESSION_ID);
  await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
  const taskStart = await captureWorkspaceSnapshot(projectDir, ref);
  writeFileSync(join(projectDir, 'lib/lerp.mjs'), 'export const lerp = 1;\n');
  mkdirSync(join(projectDir, 'test'), { recursive: true });
  writeFileSync(join(projectDir, 'test/lerp.test.mjs'), 'lerp works\n');
  const task = makeTask({ id: 'T001', title: 'Lerp', suggestedFiles: ['lib/lerp.mjs'] });
  const state: WorkflowState = {
    ...createInitialState('Checkout run'),
    phase: 'implementing',
    workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
    tasks: [{ ...task, status: 'in_progress' }],
    currentTaskIndex: 0,
    changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: taskStart },
  };
  saveState(ref, state);
  return { ref, state, task };
}

/** The snapshot a checkout run records when it comes to rest. */
async function recordRestSnapshot(ref: { projectDir: string; sessionId: string }) {
  const rest = await createSnapshot({ ...ref, phase: 'manual', name: 'post-task-0' });
  await recordRunSnapshot(ref.projectDir, ref.sessionId, rest.manifest, 'post-task');
}

async function writeRunLockfile(ref: { projectDir: string; sessionId: string }, pid: number) {
  await writeLockfile(sessionDir(ref.projectDir, ref.sessionId), {
    pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: ref.sessionId,
    feature: 'Checkout run',
  });
}

/** A run's process records the rest snapshot as it exits, then marks its lockfile exited. */
async function exitRunProcess(ref: { projectDir: string; sessionId: string }) {
  await writeRunLockfile(ref, process.pid);
  await recordRestSnapshot(ref);
  await markExited(sessionDir(ref.projectDir, ref.sessionId), 0);
}

function checkoutFiles(projectDir: string) {
  return {
    keep: readFileSync(join(projectDir, 'src/keep.ts'), 'utf8'),
    gone: existsSync(join(projectDir, 'src/gone.ts')),
    fresh: existsSync(join(projectDir, 'src/new.ts')),
    binary: existsSync(join(projectDir, 'assets/logo.bin')),
  };
}

describe('closeRunIfOpen on a workspace run before Apply', () => {
  it.each([
    { strategy: 'worktree', as: undefined, closedAs: 'ended' },
    { strategy: 'staged-copy', as: 'discarded', closedAs: 'discarded' },
  ] as const)(
    '$strategy: $closedAs writes run.patch and leaves the checkout untouched',
    { timeout: 60_000 },
    async ({ strategy, as, closedAs }) => {
      const { ref, state, workspaceDir } = await openWorkspaceRun(strategy);
      const before = checkoutFiles(ref.projectDir);
      const { bus, events } = makeBusRecorder();

      const closure = await closeRunIfOpen({ ...ref, bus }, state, as);

      const patchPath = join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch');
      expect(closure.closedNow).toBe(true);
      expect(loadState(ref)?.closed).toMatchObject({
        as: closedAs,
        patch: join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch'),
      });
      expect(existsSync(patchPath)).toBe(true);
      expect(checkoutFiles(ref.projectDir)).toEqual(before);
      expect(existsSync(workspaceDir)).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'warning' &&
            event.message.includes(join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch')),
        ),
      ).toBe(false);

      const replay = createTempDir('close-run-replay-');
      dirs.push(replay);
      cpSync(join(ref.projectDir, 'src'), join(replay, 'src'), { recursive: true });
      execFileSync('git', ['apply', patchPath], { cwd: replay, stdio: 'pipe' });
      expect(readFileSync(join(replay, 'src/keep.ts'), 'utf8')).toBe(
        'export const one = 1;\nexport const two = 22;\n',
      );
      expect(existsSync(join(replay, 'src/gone.ts'))).toBe(false);
      expect(readFileSync(join(replay, 'src/new.ts'), 'utf8')).toBe(
        'export const fresh = "new";\n',
      );
      expect(readFileSync(join(replay, 'assets/logo.bin'))).toEqual(BINARY);
    },
  );

  it('writes the patch before it removes the workspace', { timeout: 60_000 }, async () => {
    const { ref, state } = await openWorkspaceRun('worktree');

    await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, state);

    expect(removal.patchExisted).toEqual([true]);
  });

  it('End run discards a ready result and saves its patch', { timeout: 60_000 }, async () => {
    const { ref, state } = await openWorkspaceRun('worktree');
    const ready: WorkflowState = { ...state, phase: 'complete', reviewStatus: 'passed' };
    saveState(ref, ready);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, ready);

    expect(closure.state.closed?.as).toBe('discarded');
    expect(loadState(ref)?.closed?.as).toBe('discarded');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(true);
  });

  it('End run discards an empty ready result without a patch or apply warning', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir, base } = await openWorkspaceRun('staged-copy');
    await reconcileWorkspaceToBase({
      ...ref,
      snapshotId: base.manifest.id,
      workspaceDir,
      keep: [],
    });
    const ready: WorkflowState = { ...state, phase: 'complete', reviewStatus: 'passed' };
    saveState(ref, ready);
    const { bus, events } = makeBusRecorder();

    const closure = await closeRunIfOpen({ ...ref, bus }, ready);

    expect(closure.closedNow).toBe(true);
    expect(closure.state.closed?.as).toBe('discarded');
    expect(loadState(ref)?.closed?.as).toBe('discarded');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(false);
    expect(closure.state.closed?.patch).toBeUndefined();
    expect(loadState(ref)?.closed?.patch).toBeUndefined();
    expect(
      events.some(
        (event) => event.type === 'warning' && event.message.includes('apply them with git apply'),
      ),
    ).toBe(false);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it('End run from a recovery halt writes run.patch and removes the workspace', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    const halted: WorkflowState = {
      ...state,
      phase: 'final-review',
      pendingRecovery: buildReviewFailedRecoveryIssue({
        phase: 'final-review',
        failure: { kind: 'call-failed', code: 'non-zero-exit', message: 'CLI exited with code 1' },
        createdAt: '2026-10-05T00:00:00.000Z',
      }),
    };
    saveState(ref, halted);
    const { bus, events } = makeBusRecorder();

    const result = await applyRecoveryAction({ ...ref, state: halted, action: 'end-run', bus });

    expect(result).toMatchObject({ ok: true, status: 'closed' });
    expect(result.state.closed?.as).toBe('ended');
    expect(loadState(ref)?.closed).toMatchObject({
      as: 'ended',
      patch: join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch'),
    });
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(true);
    expect(removal.patchExisted).toEqual([true]);
    expect(existsSync(workspaceDir)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message.includes(join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch')),
      ),
    ).toBe(false);
    expect(events.map((event) => event.type)).toContain('workspace_closed');
  });

  it('End run on the plan card of a run that kept its workspace writes run.patch and removes it', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    const atCard: WorkflowState = { ...state, phase: 'reviewing-plan', tasks: [] };
    saveState(ref, atCard);
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
    });

    const result = await runPlanApproval(
      {
        wctx: makeWctx({ ...ref, bus: makeBusRecorder().bus, callbacks }),
        planner: makePlanner(),
        state: atCard,
        feature: atCard.feature,
      },
      atCard,
    );

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
    expect(loadState(ref)?.closed?.as).toBe('ended');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(true);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it('a failed patch write keeps the run open and the workspace in place', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    mkdirSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'));

    await expect(closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, state)).rejects.toThrow();

    expect(loadState(ref)?.closed).toBeUndefined();
    expect(existsSync(workspaceDir)).toBe(true);
    expect(removal.patchExisted).toEqual([]);
  });

  it('a close that fails inside a brief books nothing, so a Continue restarts that brief clean', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    const brief = makeTask({ id: 'T001', title: 'First', suggestedFiles: ['src/partial.ts'] });
    const taskStart = await captureWorkspaceSnapshot(workspaceDir, ref);
    writeFileSync(join(workspaceDir, 'src/partial.ts'), 'export const partial = true;\n');
    const stopped: WorkflowState = {
      ...state,
      tasks: [{ ...brief, status: 'in_progress' }],
      currentTaskIndex: 0,
      changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: taskStart },
    };
    saveState(ref, stopped);
    mkdirSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'));

    await expect(closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, stopped)).rejects.toThrow();

    expect(loadState(ref)?.closed).toBeUndefined();
    expect(readEvidenceLedger(ref)).toBeNull();
  });

  // In a real run, End run during the BUILD call of T003: run.patch held the files T003 had
  // written, and the closed block's Files list left them out.
  it('End run inside a brief books what that brief left, so the record lists the patch files', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('worktree');
    const first = makeTask({ id: 'T001', title: 'First', suggestedFiles: ['src/keep.ts'] });
    const second = makeTask({ id: 'T002', title: 'Second', suggestedFiles: ['src/partial.ts'] });
    writeEvidenceLedger(
      ref,
      recordLocalTaskEvidence({
        ledger: createEvidenceLedger({
          sessionId: SESSION_ID,
          feature: state.feature,
          tasks: [first, second],
        }),
        task: first,
        status: 'done',
        changedFiles: ['assets/logo.bin', 'src/gone.ts', 'src/keep.ts', 'src/new.ts'],
      }),
    );
    const secondStart = await captureWorkspaceSnapshot(workspaceDir, ref);
    writeFileSync(join(workspaceDir, 'src/partial.ts'), 'export const partial = true;\n');
    const stopped: WorkflowState = {
      ...state,
      tasks: [
        { ...first, status: 'done' },
        { ...second, status: 'in_progress' },
      ],
      currentTaskIndex: 1,
      changedFilesBaseline: { head: null, fingerprints: {}, activeTaskSnapshot: secondStart },
    };
    saveState(ref, stopped);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, stopped);
    const summary = finalizeRunAtRest({ ref, config: createDefaultConfig(), state: closure.state });

    const patch = readFileSync(
      join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'),
      'utf8',
    );
    const patchFiles = [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((match) => match[1]);
    expect(summary.changedFiles).toEqual(patchFiles);
    expect(summary.stoppedAt).toEqual({ taskId: 'T002', partialFiles: ['src/partial.ts'] });
  });

  it('closes a run whose workspace is already gone and says no patch was written', {
    timeout: 60_000,
  }, async () => {
    const { ref, state, workspaceDir } = await openWorkspaceRun('staged-copy');
    rmSync(dirname(workspaceDir), { recursive: true, force: true });
    const { bus, events } = makeBusRecorder();

    const closure = await closeRunIfOpen({ ...ref, bus }, state);

    expect(closure.closedNow).toBe(true);
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch'))).toBe(false);
    expect(events.some((event) => event.type === 'warning')).toBe(true);
  });

  it('a run without a workspace closes without a patch', async () => {
    const projectDir = createTempDir('close-run-checkout-');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: SESSION_ID };
    ensureSessionDir(projectDir, SESSION_ID);
    const state = { ...createInitialState('Checkout run'), phase: 'implementing' as const };
    saveState(ref, state);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, state);

    expect(closure.state.closed?.as).toBe('ended');
    expect(existsSync(join(sessionDir(projectDir, SESSION_ID), 'run.patch'))).toBe(false);
    expect(removal.patchExisted).toEqual([]);
  });

  it('a checkout-mode run closes without a patch and says nothing is unapplied', async () => {
    const projectDir = createTempDir('close-run-checkout-mode-');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: SESSION_ID };
    ensureSessionDir(projectDir, SESSION_ID);
    writeFileSync(join(projectDir, 'kept.ts'), 'edited in place\n');
    const state: WorkflowState = {
      ...createInitialState('Checkout run'),
      phase: 'implementing',
      workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    const closure = await closeRunIfOpen({ ...ref, bus }, state);

    expect(closure.state.closed?.as).toBe('ended');
    expect(existsSync(join(sessionDir(projectDir, SESSION_ID), 'run.patch'))).toBe(false);
    expect(readFileSync(join(projectDir, 'kept.ts'), 'utf8')).toBe('edited in place\n');
    expect(removal.patchExisted).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.code === undefined &&
          event.message.includes('nothing is unapplied and no run patch was written'),
      ),
    ).toBe(true);
  });

  // RC6 run A: after `/run reject confirm` removed the run's files, the close said they were
  // "already there" and booked the user's later-user.txt and README.md as the stopped brief's.
  it('closes a checkout run a reject put back as discarded, with no claim and only the brief files', async () => {
    const { ref, state } = await checkoutRunInBrief();
    await exitRunProcess(ref);
    writeFileSync(join(ref.projectDir, 'later-user.txt'), 'the user wrote this after the stop\n');
    const { bus, events } = makeBusRecorder();

    const { closure } = await rejectCheckoutRun({ ...ref, bus }, state);

    expect(closure?.state.closed?.as).toBe('discarded');
    expect(existsSync(join(ref.projectDir, 'lib/lerp.mjs'))).toBe(false);
    expect(existsSync(join(sessionDir(ref.projectDir, SESSION_ID), 'run.patch'))).toBe(false);
    expect(events.filter((event) => event.type === 'warning')).toEqual([]);
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: ['lib/lerp.mjs', 'test/lerp.test.mjs'],
    });
  });

  // A Seat down halt records no kept files: End run after it booked nothing for the halted brief,
  // and the closed Files list left out the files it had written to the checkout.
  it('End run after a Seat down halt in a checkout books what the brief wrote up to the rest, not later user edits', async () => {
    const { ref, state, task } = await checkoutRunInBrief();
    await exitRunProcess(ref);
    writeFileSync(join(ref.projectDir, 'later-user.txt'), 'the user wrote this after the halt\n');
    writeFileSync(join(ref.projectDir, 'lib/clamp.mjs'), 'the user edited this after the halt\n');
    const halted: WorkflowState = {
      ...state,
      interruptedStep: {
        step: { kind: 'brief', taskId: task.id, attempt: 0 },
        source: 'seat',
        cut: 'mid-step',
        at: '2026-10-16T21:37:07.841Z',
      },
    };
    saveState(ref, halted);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, halted);

    expect(closure.state.closed?.as).toBe('ended');
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: ['lib/lerp.mjs', 'test/lerp.test.mjs'],
    });
    expect(readFileSync(join(ref.projectDir, 'later-user.txt'), 'utf8')).toBe(
      'the user wrote this after the halt\n',
    );
  });

  it('a checkout run that closes in its own process books the brief from the checkout as it is', async () => {
    const { ref, state } = await checkoutRunInBrief();
    await writeRunLockfile(ref, process.pid);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, state);

    expect(closure.state.closed?.as).toBe('ended');
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: ['lib/lerp.mjs', 'test/lerp.test.mjs'],
    });
  });

  // A process killed inside a brief records no rest snapshot: the latest one is older than what
  // the brief wrote, so End run booked nothing of the brief while its files stayed in the checkout.
  it('End run after the run process died in a brief books the brief from the checkout as it is', async () => {
    const { ref, state } = await checkoutRunInBrief();
    await recordRestSnapshot(ref);
    writeFileSync(join(ref.projectDir, 'lib/smooth.mjs'), 'written after the last rest\n');
    await writeRunLockfile(ref, 99999999);

    const closure = await closeRunIfOpen({ ...ref, bus: makeBusRecorder().bus }, state);

    expect(closure.state.closed?.as).toBe('ended');
    expect(readEvidenceLedger(ref)?.tasks.find((task) => task.id === 'T001')).toMatchObject({
      status: 'in_progress',
      changedFiles: ['lib/lerp.mjs', 'lib/smooth.mjs', 'test/lerp.test.mjs'],
    });
  });
});
