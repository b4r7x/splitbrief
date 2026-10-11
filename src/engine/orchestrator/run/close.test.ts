import { afterEach, describe, expect, it } from 'vitest';
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
import { endRunAtRest } from './close.js';

let projectDir: string;

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('endRunAtRest', () => {
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

    const closure = await endRunAtRest({ ...ref, bus }, state, makeConfig());

    expect(closure.closedNow).toBe(true);
    expect(closure.state.closed?.as).toBe('ended');
    expect(loadState(ref)?.closed).toEqual(closure.state.closed);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toEqual([
      expect.objectContaining({ phase: 'implementing', reason: 'user_cancelled' }),
    ]);
    expect(readSession(ref)?.status).toBe('ended');
    expect(readActive(projectDir)).toBeNull();
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
