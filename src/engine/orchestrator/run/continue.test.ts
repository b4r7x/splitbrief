import { describe, it, expect } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OwnedResumeState } from '../../../core/state/resume-hydration.js';
import { createInitialState } from '../../../core/state/machine.js';
import { continueRun, type ContinueRunDeps } from './continue.js';

const REF = { projectDir: '/tmp/project', sessionId: 'sess-1' };

function makeDeps(overrides: Partial<ContinueRunDeps> & { loaded?: OwnedResumeState }): {
  deps: ContinueRunDeps;
  parked: string[];
  restarted: { state: WorkflowState; steer: string | undefined }[];
} {
  const parked: string[] = [];
  const restarted: { state: WorkflowState; steer: string | undefined }[] = [];
  const deps: ContinueRunDeps = {
    resumeParked:
      overrides.resumeParked ??
      ((steer) => {
        parked.push(steer);
        return false;
      }),
    loadState: overrides.loadState ?? (() => overrides.loaded ?? { kind: 'missing' }),
    restart: overrides.restart ?? ((input) => restarted.push(input)),
  };
  return { deps, parked, restarted };
}

function openState(): WorkflowState {
  return { ...createInitialState('feat'), phase: 'implementing' };
}

describe('continueRun', () => {
  it('settles a park this process holds and never touches the state', () => {
    let loads = 0;
    const { deps, parked } = makeDeps({
      resumeParked: (steer) => {
        parked.push(steer);
        return true;
      },
      loadState: () => {
        loads += 1;
        return { kind: 'missing' };
      },
    });

    expect(continueRun({ ref: REF, steer: 'try the other helper', deps })).toEqual({
      kind: 'continued-in-place',
    });
    expect(parked).toEqual(['try the other helper']);
    expect(loads).toBe(0);
  });

  it('settles a park with an empty steer when the operator only asked to continue', () => {
    const settled: string[] = [];
    const { deps } = makeDeps({
      resumeParked: (steer) => {
        settled.push(steer);
        return true;
      },
    });

    expect(continueRun({ ref: REF, deps }).kind).toBe('continued-in-place');
    expect(settled).toEqual(['']);
  });

  it('re-enters a run at rest on its saved state, carrying the steer', () => {
    const state = openState();
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    expect(continueRun({ ref: REF, steer: '  keep the old API  ', deps })).toEqual({
      kind: 'restarted',
      state,
    });
    expect(restarted).toEqual([{ state, steer: 'keep the old API' }]);
  });

  it('re-enters with no steer when the operator typed nothing', () => {
    const state = openState();
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    continueRun({ ref: REF, steer: '   ', deps });

    expect(restarted).toEqual([{ state, steer: undefined }]);
  });

  it('refuses a run that was ended', () => {
    const state: WorkflowState = {
      ...openState(),
      closed: { at: '2026-01-01T00:00:00.000Z', as: 'ended' },
    };
    const { deps, restarted } = makeDeps({ loaded: { kind: 'loaded', state } });

    const outcome = continueRun({ ref: REF, deps });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(restarted).toEqual([]);
  });

  it('refuses a run that passed its final review', () => {
    const state: WorkflowState = {
      ...openState(),
      phase: 'complete',
      reviewStatus: 'passed',
    };
    const { deps } = makeDeps({ loaded: { kind: 'loaded', state } });

    const outcome = continueRun({ ref: REF, deps });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(outcome.kind === 'refused' && outcome.message).toContain('complete');
  });

  it('refuses when there is no saved state', () => {
    const { deps } = makeDeps({ loaded: { kind: 'missing' } });

    expect(continueRun({ ref: REF, deps })).toMatchObject({ kind: 'refused', reason: 'missing' });
  });

  it('refuses with the loader reason when the state cannot be read', () => {
    const { deps } = makeDeps({
      loaded: { kind: 'invalid', code: 'future-version', message: 'written by a newer version' },
    });

    expect(continueRun({ ref: REF, deps })).toEqual({
      kind: 'refused',
      reason: 'invalid',
      message: 'written by a newer version',
    });
  });
});
