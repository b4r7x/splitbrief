import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { readActive, reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readSession } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { sessionDir } from '../../../core/paths.js';
import { writeRunPatch } from '../apply/patch.js';
import { removeRunWorkspace } from '../isolation/remove-worktree.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import {
  closedChangesSuffix,
  closeRunIfOpen,
  endRunAtRest,
  filesStillOnDiskSuffix,
} from './close.js';

vi.mock('../apply/patch.js', () => ({ writeRunPatch: vi.fn() }));
vi.mock('../isolation/remove-worktree.js', () => ({ removeRunWorkspace: vi.fn() }));

let projectDir: string | undefined;

afterEach(() => {
  vi.resetAllMocks();
  if (projectDir !== undefined) cleanupTempDir(projectDir);
});

describe('run closure during Apply', () => {
  it.each(['end-run', 'discard'] as const)(
    'refuses %s when Apply starts while the patch is being written',
    async (action) => {
      projectDir = createTempDir('close-run-apply-race-');
      const ref = { projectDir, sessionId: 'apply-race' };
      reactivateExistingSession(ref);
      const workspacePath = join(projectDir, 'workspace');
      mkdirSync(workspacePath);
      const state: WorkflowState = {
        ...createInitialState('Apply races with closure'),
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: workspacePath,
          base: { snapshotId: 'base', head: null },
        },
      };
      saveState(ref, state);
      let saved = loadState(ref);
      vi.mocked(writeRunPatch).mockImplementationOnce(async () => {
        saveState(ref, {
          ...state,
          stateRevision: (saved?.stateRevision ?? 0) + 1,
          applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
          pendingRecovery: makeRecoveryIssue({
            reason: 'apply-partial',
            availableActions: ['retry-same-worker', 'restore-backup'],
          }),
        });
        saved = loadState(ref);
        return join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch');
      });
      const { bus, events } = makeBusRecorder();

      await expect(
        action === 'end-run'
          ? endRunAtRest({ ...ref, bus }, state, makeConfig())
          : closeRunIfOpen({ ...ref, bus }, state, 'discarded'),
      ).rejects.toThrow('Restore or retry Apply first');

      expect(vi.mocked(writeRunPatch)).toHaveBeenCalledOnce();
      expect(loadState(ref)).toEqual(saved);
      expect(loadState(ref)?.closed).toBeUndefined();
      expect(loadState(ref)?.applying?.backupId).toBe('apply-backup');
      expect(loadState(ref)?.pendingRecovery?.reason).toBe('apply-partial');
      expect(readActive(projectDir)).toBe(ref.sessionId);
      expect(readSession(ref)).toBeNull();
      expect(existsSync(workspacePath)).toBe(true);
      expect(removeRunWorkspace).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    },
  );
});

describe('endRunAtRest', () => {
  it('leaves a closed run that still records Apply closed', async () => {
    projectDir = createTempDir('close-closed-applying-');
    const ref = { projectDir, sessionId: 'closed-applying' };
    const state: WorkflowState = {
      ...createInitialState('Closed during Apply'),
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
      closed: { at: '2026-10-11T00:00:01.000Z', as: 'ended' },
    };
    saveState(ref, state);
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    await expect(endRunAtRest({ ...ref, bus }, state, makeConfig())).resolves.toMatchObject({
      closedNow: false,
    });

    expect(loadState(ref)).toEqual(saved);
    expect(events).toEqual([]);
  });

  it('refuses End run from the recovery action without clearing restore', async () => {
    projectDir = createTempDir('end-run-apply-recovery-');
    const ref = { projectDir, sessionId: 'apply-recovery' };
    const state: WorkflowState = {
      ...createInitialState('Partial Apply'),
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
      pendingRecovery: makeRecoveryIssue({
        reason: 'apply-partial',
        availableActions: ['retry-same-worker', 'restore-backup', 'end-run'],
      }),
    };
    saveState(ref, state);
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    await expect(applyRecoveryAction({ ...ref, bus, state, action: 'end-run' })).rejects.toThrow(
      'Restore or retry Apply first',
    );

    expect(loadState(ref)).toEqual(saved);
    expect(events).toEqual([]);
  });

  it('refuses End run from stale state when the saved state still records Apply', async () => {
    projectDir = createTempDir('end-run-applying-');
    const ref = { projectDir, sessionId: 'applying-run' };
    reactivateExistingSession(ref);
    const stale = createInitialState('Interrupted Apply');
    saveState(ref, {
      ...stale,
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
    });
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    await expect(endRunAtRest({ ...ref, bus }, stale, makeConfig())).rejects.toThrow(
      'Restore or retry Apply first',
    );

    expect(loadState(ref)).toEqual(saved);
    expect(readActive(projectDir)).toBe(ref.sessionId);
    expect(readSession(ref)).toBeNull();
    expect(events).toEqual([]);
  });

  it('closes a stopped run, publishes one cancellation and finalizes the session', async () => {
    projectDir = createTempDir('end-run-at-rest-');
    const ref = { projectDir, sessionId: 'stopped-run' };
    reactivateExistingSession(ref);
    const state: WorkflowState = {
      ...createInitialState('End a stopped run'),
      phase: 'implementing',
      awaitingContinue: true,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const before = Date.now();

    const closure = await endRunAtRest({ ...ref, bus }, state, makeConfig());

    expect(closure.closedNow).toBe(true);
    expect(closure.state.closed?.as).toBe('ended');
    expect(loadState(ref)?.closed).toEqual(closure.state.closed);
    const cancels = events.filter((event) => event.type === 'workflow_cancelled');
    expect(cancels).toEqual([
      expect.objectContaining({ phase: 'implementing', reason: 'user_cancelled' }),
    ]);
    // The End is marked as taken at rest, from before it wrote anything.
    const atRestFrom = cancels[0]?.atRestFrom ?? 0;
    expect(atRestFrom).toBeGreaterThanOrEqual(before);
    expect(atRestFrom).toBeLessThanOrEqual(cancels[0]?.ts ?? 0);
    expect(readSession(ref)?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();
  });

  it('discards a ready run and publishes no cancellation, because nothing was running', async () => {
    projectDir = createTempDir('end-run-ready-');
    const ref = { projectDir, sessionId: 'ready-run' };
    reactivateExistingSession(ref);
    const workspacePath = join(projectDir, 'workspace');
    mkdirSync(workspacePath);
    const state: WorkflowState = {
      ...createInitialState('End a ready run'),
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: workspacePath,
        base: { snapshotId: 'base', head: null },
      },
    };
    saveState(ref, state);
    vi.mocked(writeRunPatch).mockResolvedValueOnce(
      join(sessionDir(projectDir, ref.sessionId), 'run.patch'),
    );
    const { bus, events } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, state, makeConfig());

    expect(closure.closedNow).toBe(true);
    expect(closure.state.closed).toMatchObject({
      as: 'discarded',
      patch: '.splitbrief/sessions/ready-run/run.patch',
    });
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['workspace_closed']);
    expect(readSession(ref)?.status).toBe('ended');
  });

  it('leaves an already closed run state unchanged and publishes no cancellation', async () => {
    projectDir = createTempDir('end-run-closed-');
    const ref = { projectDir, sessionId: 'closed-run' };
    const state: WorkflowState = {
      ...createInitialState('An ended run'),
      phase: 'implementing',
      closed: { as: 'ended', at: '2026-10-11T00:00:00.000Z' },
    };
    saveState(ref, state);
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, state, makeConfig());

    expect(closure.closedNow).toBe(false);
    expect(closure.state).toEqual(saved);
    expect(loadState(ref)).toEqual(saved);
    expect(events).toEqual([]);
  });

  it('resolves a pending recovery once, cancels and finalizes the ended run', async () => {
    projectDir = createTempDir('end-run-recovery-');
    const ref = { projectDir, sessionId: 'halted-run' };
    reactivateExistingSession(ref);
    const issue = makeRecoveryIssue({
      availableActions: ['retry-same-worker', 'skip-current-task'],
    });
    const state: WorkflowState = {
      ...createInitialState('End a halted run'),
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', status: 'failed' })],
      pendingRecovery: issue,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, state, makeConfig());

    expect(closure.closedNow).toBe(true);
    expect(closure.state.closed?.as).toBe('ended');
    expect(closure.state.pendingRecovery).toBeUndefined();
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
    expect(events.filter((event) => event.type === 'recovery_resolved')).toEqual([
      expect.objectContaining({ issueId: issue.id, action: 'end-run', outcome: 'aborted' }),
    ]);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
    expect(readSession(ref)?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();

    const ended = loadState(ref);
    const again = await endRunAtRest({ ...ref, bus }, state, makeConfig());
    expect(again.closedNow).toBe(false);
    expect(loadState(ref)).toEqual(ended);
    expect(events.filter((event) => event.type === 'recovery_resolved')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
  });
});

describe('the close line names files on disk only once a brief started in the checkout', () => {
  const STILL_ON_DISK = ' The files it wrote are still on disk.';
  const checkout: WorkflowState['workspace'] = {
    kind: 'checkout',
    path: '/project',
    base: { snapshotId: 'base', head: null },
  };
  const worktree: WorkflowState['workspace'] = {
    kind: 'worktree',
    path: '/trees/run',
    base: { snapshotId: 'base', head: null },
  };
  const planned = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
  const built = [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })];

  it.each([
    ['a run that ended while it planned', { phase: 'planning' as const, tasks: [] }, ''],
    ['a run that ended at its plan card', { phase: 'reviewing-plan' as const, tasks: planned }, ''],
    [
      'a run halted before its first brief started',
      { phase: 'implementing' as const, tasks: planned },
      '',
    ],
    [
      'a checkout run halted before its first brief started',
      { phase: 'implementing' as const, tasks: planned, workspace: checkout },
      '',
    ],
    [
      'a checkout run with a brief started',
      { phase: 'implementing' as const, tasks: built, workspace: checkout },
      STILL_ON_DISK,
    ],
    [
      'an older run without a workspace with a brief started',
      { phase: 'implementing' as const, tasks: built },
      STILL_ON_DISK,
    ],
    [
      'a worktree run with a brief started',
      { phase: 'implementing' as const, tasks: built, workspace: worktree },
      '',
    ],
  ])('%s', (_name, overrides, expected) => {
    const state: WorkflowState = { ...createInitialState('Close line'), ...overrides };

    expect(filesStillOnDiskSuffix(state)).toBe(expected);
    expect(
      closedChangesSuffix({ ...state, closed: { at: '2026-10-19T00:00:00.000Z', as: 'ended' } }),
    ).toBe(expected);
  });
});
