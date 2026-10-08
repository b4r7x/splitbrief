import { describe, it, expect } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { taskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { stepWord, stopByline, type StopBylineInput } from './copy.js';

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
    questionPending: false,
    suite: null,
    ...overrides,
  };
}

const PARKED_HINT = '⏎ resume · /stop options · esc back to sessions · ctrl+c quit';

/** A stop the run settled from: the park names no brief, and the record says where it stopped. */
function settled(resumeAt: StepRef, at: 'mid-step' | 'boundary' = 'mid-step') {
  return input({
    intent: 'stop-now',
    phase: 'parked',
    parked: { kind: 'mid-brief', taskId: null },
    currentTaskId: null,
    record: makeRunRecord({
      status: { kind: 'open', stop: { kind: 'stopped', on: { kind: 'paused', at } }, resumeAt },
    }),
  });
}

/** A run End run closed: the record keeps the state it closed on and the summary it wrote. */
function ended(
  state: Partial<WorkflowState>,
  summary: Partial<Summary> = {},
  ledger: EvidenceLedger | null = null,
) {
  return input({
    intent: 'end-run',
    phase: 'ended',
    currentTaskId: null,
    record: makeRunRecord({
      status: { kind: 'closed', as: 'ended' },
      hydration: { kind: 'loaded', state: makeWorkflowState(state) },
      summary: makeSummary(summary),
      ledger,
    }),
  });
}

describe('stopByline', () => {
  it('says nothing while the run is untouched', () => {
    expect(stopByline(input())).toBeNull();
  });

  it('names the brief it is stopping and how long it has waited', () => {
    expect(stopByline(input({ intent: 'stop-now', phase: 'terminating' }))).toEqual({
      lead: 'Stopping T002 · Waiting for processes to exit · 0:03',
      hint: 'esc back after stop · ctrl+c quit after stop',
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

  it('names the brief the pause outlived, which the run has just finished', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
    });

    expect(stopByline(paused)).toEqual({
      lead: 'Finishing T003',
      hint: 'Pause requested; no next brief will start',
    });
  });

  it('names the run when a pause is armed before any brief has finished', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
    });

    expect(stopByline(paused)?.lead).toBe('Finishing the run');
  });

  // S8 run 18:06–18:58: with a pause armed, the ten-minute boundary suite read `Finishing the run`.
  it('names the full-suite stage a pause waits on, with its command and its clock', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
      suite: { moment: 'pre-review', command: 'npm test', elapsedMs: 602_000 },
    });

    expect(stopByline(paused)).toEqual({
      lead: 'Pre-review suite · npm test',
      clock: '10:02',
      hint: 'Pause requested; no next brief will start',
    });
  });

  it('names the reviewer check a pause waits on by its id', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
      suite: { id: 'V2', moment: 'pre-review', command: 'npm test', elapsedMs: 42_000 },
    });

    expect(stopByline(paused)).toMatchObject({
      lead: 'Reviewer check V2 · npm test',
      clock: '0:42',
    });
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
      lead: 'Stopped at T002 · Partial changes kept',
      hint: '⏎ resume · /stop options · esc back to sessions · ctrl+c quit',
    });
  });

  // UI debt #57: the transcript named the brief the stop held back, this byline the brief that passed.
  it("parks at a boundary with the next brief and the count, in the transcript row's words", () => {
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
      lead: 'Stopped before T003 · 2 of 5 briefs complete',
      hint: '⏎ resume · /stop options · esc back to sessions · ctrl+c quit',
    });
  });

  it('names the gate a planning stop settled at and claims no changes', () => {
    expect(stopByline(settled({ kind: 'gate', gate: 'plan' }))).toEqual({
      lead: 'Stopped at the plan',
      hint: PARKED_HINT,
    });
  });

  it('names the planner step a stop cut, which changed no files', () => {
    expect(stopByline(settled({ kind: 'planner', call: 'tasks' }))?.lead).toBe(
      'Stopped at the plan',
    );
  });

  it('keeps the partial-changes claim for a brief the stop cut mid-step', () => {
    expect(stopByline(settled({ kind: 'brief', taskId: taskId('T003'), attempt: 0 }))?.lead).toBe(
      'Stopped at T003 · Partial changes kept',
    );
  });

  it('claims no partial changes for a brief the run stopped before', () => {
    expect(
      stopByline(settled({ kind: 'brief', taskId: taskId('T003'), attempt: 0 }, 'boundary'))?.lead,
    ).toBe('Stopped before T003');
  });

  it('says only that it paused when a park names no step at all', () => {
    expect(
      stopByline(
        input({
          intent: 'stop-now',
          phase: 'parked',
          parked: { kind: 'mid-brief', taskId: null },
          currentTaskId: null,
        }),
      )?.lead,
    ).toBe('Stopped');
  });

  // S11 run, 04:55: after End run the byline called T005 cancelled with its changes kept, while
  // the closed line read `× Ended · Build 4/13 · stopped in T005` and the changes sat in run.patch.
  // A run End run closed is a closed run: its own closed byline speaks for it, and the closed block
  // states where it stopped and what it kept.
  it.each([
    ['at the plan gate', () => ended({ phase: 'reviewing-plan' })],
    [
      'inside a brief',
      () => {
        const task = makeTask({ id: 'T003', status: 'in_progress' });
        const ledger = createEvidenceLedger({
          sessionId: 'proof',
          feature: 'proof',
          tasks: [task],
        });
        return ended(
          { phase: 'implementing', tasks: [task] },
          {
            changedFiles: ['src/a.ts', 'src/b.ts'],
            stoppedAt: { taskId: taskId('T003'), partialFiles: ['src/b.ts'] },
          },
          ledger,
        );
      },
    ],
    ['at the review', () => ended({ phase: 'final-review' }, { changedFiles: ['src/a.ts'] })],
    ['before the record was re-read', () => input({ intent: 'end-run', phase: 'ended' })],
  ] as const)('leaves the byline to the closed run once End run closed it %s', (_label, make) => {
    expect(stopByline(make())).toBeNull();
  });

  it('names the wait while a run is ending', () => {
    expect(stopByline(input({ intent: 'end-run', phase: 'terminating' }))?.lead).toBe(
      'Ending run · Waiting for processes to exit · 0:03',
    );
  });

  it('says it is saving the session on the way out', () => {
    expect(stopByline(input({ intent: 'quit', phase: 'terminating' }))).toEqual({
      lead: 'Quitting',
      hint: 'Stopping processes and saving session',
    });
  });
});

it('does not claim a live process during cleanup or persistence', () => {
  const byline = stopByline(input({ intent: 'stop-now', phase: 'settling' }));
  expect(byline?.lead).toContain('Finishing cleanup and saving');
  expect(byline?.lead).not.toContain('processes');
});

it('reports the actual cleanup failure and the retry action', () => {
  expect(stopByline(input({ intent: 'stop-now', phase: 'failed', error: 'Disk full' }))).toEqual({
    lead: 'Stop failed · Disk full',
    hint: '/stop to retry',
  });
});

describe('stepWord', () => {
  it.each([
    [{ kind: 'planner', call: 'spec' } as const, 'the plan'],
    [{ kind: 'planner', call: 'plan' } as const, 'the plan'],
    [{ kind: 'gate', gate: 'briefs' } as const, 'the plan'],
    [{ kind: 'brief', taskId: taskId('T007'), attempt: 0 } as const, 'T007'],
    [{ kind: 'review', cycle: 1 } as const, 'the review'],
  ])('names %o as %s', (step, word) => {
    expect(stepWord(step)).toBe(word);
  });
});
