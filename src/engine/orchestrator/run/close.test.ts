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
import { createSnapshot } from '../../snapshots/create.js';
import { reconcileWorkspaceToBase } from '../isolation/acquisition.js';
import { createRunIsolation } from '../isolation/create.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { runPlanApproval } from '../planning/session.js';
import { closeRunIfOpen } from './close.js';

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
    onRetained: () => {},
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
  return { ref, state, workspaceDir };
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
      expect(loadState(ref)?.closed?.as).toBe(closedAs);
      expect(existsSync(patchPath)).toBe(true);
      expect(checkoutFiles(ref.projectDir)).toEqual(before);
      expect(existsSync(workspaceDir)).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'warning' &&
            event.message.includes(join(SPLITBRIEF_DIR, 'sessions', SESSION_ID, 'run.patch')),
        ),
      ).toBe(true);

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
    expect(loadState(ref)?.closed?.as).toBe('ended');
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
    ).toBe(true);
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
          event.message.includes('nothing is unapplied and no run patch was written'),
      ),
    ).toBe(true);
  });
});
