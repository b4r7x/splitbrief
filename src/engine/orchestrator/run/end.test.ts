import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeLegacyV3State, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readActive, reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readSession } from '../../../core/sessions/io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { writeRunPatch } from '../apply/patch.js';
import { removeRunWorkspace } from '../isolation/worktree/remove.js';
import { applyRecoveryAction } from '../recovery/actions/apply.js';
import { endRunAtRest } from './end.js';

vi.mock('../apply/patch.js', () => ({ writeRunPatch: vi.fn() }));
vi.mock('../isolation/worktree/remove.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../isolation/worktree/remove.js')>();
  return {
    ...actual,
    removeRunWorkspace: vi.fn().mockResolvedValue(null),
  };
});

let projectDir: string | undefined;

beforeEach(() => {
  vi.mocked(removeRunWorkspace).mockResolvedValue(null);
});

afterEach(() => {
  vi.resetAllMocks();
  if (projectDir !== undefined) cleanupTempDir(projectDir);
});

describe('endRunAtRest', () => {
  it('leaves a closed run that still records Apply closed', async () => {
    projectDir = createTempDir('close-closed-applying-');
    const ref = { projectDir, sessionId: 'closed-applying' };
    const state: WorkflowState = {
      ...createInitialState('Closed during Apply'),
      ...RUN_CREW,
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
      closed: { at: '2026-10-11T00:00:01.000Z', as: 'ended' },
    };
    saveState(ref, state);
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    await expect(endRunAtRest({ ...ref, bus }, state)).resolves.toMatchObject({
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
      ...RUN_CREW,
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
    const stale = { ...createInitialState('Interrupted Apply'), ...RUN_CREW };
    saveState(ref, {
      ...stale,
      applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
    });
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    await expect(endRunAtRest({ ...ref, bus }, stale)).rejects.toThrow(
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
      ...RUN_CREW,
      phase: 'implementing',
      awaitingContinue: true,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const before = Date.now();

    const closure = await endRunAtRest({ ...ref, bus }, state);

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

  it('ends a run saved as v3 and saves the close as v4', async () => {
    projectDir = createTempDir('end-run-v3-');
    const ref = { projectDir, sessionId: 'v3-run' };
    ensureSessionDir(projectDir, ref.sessionId);
    reactivateExistingSession(ref);
    const file = join(sessionDir(projectDir, ref.sessionId), 'state.json');
    writeFileSync(file, JSON.stringify({ ...makeLegacyV3State('End a v3 run'), ...RUN_CREW }));
    const loaded = loadState(ref);
    if (loaded === null) throw new Error('the v3 state did not load');
    // A v3 run has no workspace, so it is never ready to apply: End run ends it.
    expect(loaded.workspace).toBeUndefined();
    const { bus } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, loaded);

    expect(closure.closedNow).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      stateVersion: 4,
      closed: { as: 'ended' },
    });
    expect(readSession(ref)?.status).toBe('ended');
  });

  it('discards a ready run and publishes no cancellation, because nothing was running', async () => {
    projectDir = createTempDir('end-run-ready-');
    const ref = { projectDir, sessionId: 'ready-run' };
    reactivateExistingSession(ref);
    const workspacePath = join(projectDir, 'workspace');
    mkdirSync(workspacePath);
    const state: WorkflowState = {
      ...createInitialState('End a ready run'),
      ...RUN_CREW,
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

    const closure = await endRunAtRest({ ...ref, bus }, state);

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
      ...RUN_CREW,
      phase: 'implementing',
      closed: { as: 'ended', at: '2026-10-11T00:00:00.000Z' },
    };
    saveState(ref, state);
    const saved = loadState(ref);
    const { bus, events } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, state);

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
      ...RUN_CREW,
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', status: 'failed' })],
      pendingRecovery: issue,
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();

    const closure = await endRunAtRest({ ...ref, bus }, state);

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
    const again = await endRunAtRest({ ...ref, bus }, state);
    expect(again.closedNow).toBe(false);
    expect(loadState(ref)).toEqual(ended);
    expect(events.filter((event) => event.type === 'recovery_resolved')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(1);
  });
});
