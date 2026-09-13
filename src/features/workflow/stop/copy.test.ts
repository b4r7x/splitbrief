import { describe, it, expect } from 'vitest';
import { stopByline, type StopBylineInput } from './copy.js';

function input(overrides: Partial<StopBylineInput> = {}): StopBylineInput {
  return {
    intent: 'none',
    phase: 'idle',
    parked: null,
    currentTaskId: 'T002',
    nextTaskId: 'T003',
    passed: 1,
    total: 5,
    elapsedMs: 3_000,
    sheetOpen: false,
    questionPending: false,
    ...overrides,
  };
}

describe('stopByline', () => {
  it('says nothing while the run is untouched', () => {
    expect(stopByline(input())).toBeNull();
  });

  it('reports the run as still running behind the sheet', () => {
    expect(stopByline(input({ sheetOpen: true }))).toEqual({
      lead: 'Building T002 of 5',
      hint: 'Still running',
    });
  });

  it('names the brief it is stopping and how long it has waited', () => {
    expect(stopByline(input({ intent: 'stop-now', phase: 'terminating' }))).toEqual({
      lead: 'Stopping T002 · Waiting for processes to exit · elapsed 0:03',
      hint: 'No new work will start',
    });
  });

  it('says it is forcing once the grace is spent', () => {
    expect(stopByline(input({ intent: 'stop-now', phase: 'forcing' }))?.lead).toBe(
      'Stopping T002 · Forcing remaining processes to exit',
    );
  });

  it('reports a boundary pause as a finish rather than a termination', () => {
    expect(stopByline(input({ intent: 'pause-after-brief', phase: 'requested' }))).toEqual({
      lead: 'Finishing T002',
      hint: 'Pause requested; no next brief will start',
    });
  });

  it('asks for the answer the pause is waiting on', () => {
    expect(
      stopByline(input({ intent: 'pause-after-brief', phase: 'requested', questionPending: true })),
    ).toEqual({ lead: 'Answer needed to finish T002', hint: 'Pause requested' });
  });

  it('parks mid-brief with the keys that resume it', () => {
    expect(
      stopByline(
        input({
          intent: 'stop-now',
          phase: 'parked',
          parked: { kind: 'mid-brief', taskId: 'T002' },
        }),
      ),
    ).toEqual({
      lead: 'Paused at T002 · Partial changes kept',
      hint: '/resume · type instructions, enter to send and resume · /end · esc home',
    });
  });

  it('parks at a boundary with the count and the next brief', () => {
    expect(
      stopByline(
        input({
          intent: 'pause-after-brief',
          phase: 'parked',
          parked: { kind: 'boundary', taskId: 'T002' },
          passed: 2,
        }),
      ),
    ).toEqual({
      lead: 'Paused after T002 · 2 of 5 briefs complete',
      hint: '/resume to start T003 · /end · esc home',
    });
  });

  it('reports an ended run as cancelled with its changes kept', () => {
    expect(stopByline(input({ intent: 'end-run', phase: 'ended' }))).toEqual({
      lead: 'Cancelled by you at T002 · Changes kept',
      hint: 'esc home · /quit',
    });
  });

  it('names the wait while a run is ending', () => {
    expect(stopByline(input({ intent: 'end-run', phase: 'terminating' }))?.lead).toBe(
      'Ending run · Waiting for processes to exit · elapsed 0:03',
    );
  });

  it('says it is saving the session on the way out', () => {
    expect(stopByline(input({ intent: 'quit', phase: 'terminating' }))).toEqual({
      lead: 'Quitting',
      hint: 'Stopping processes and saving session',
    });
  });
});
