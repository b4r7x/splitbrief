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
import { buildInputFooterByline } from '../input-footer-byline.js';
import { stepWord, stopByline, stopPoint, type StopBylineInput } from './copy.js';

function input(overrides: Partial<StopBylineInput> = {}): StopBylineInput {
  return {
    intent: 'none',
    phase: 'idle',
    workflowPhase: 'implementing',
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

it('keeps a check seat word and separators distinct during a requested pause', () => {
  expect(
    stopByline(
      input({
        intent: 'pause-after-brief',
        phase: 'requested',
        workflowPhase: 'final-review',
        suite: { id: 'V1', moment: 'pre-review', command: 'npm test', elapsedMs: 42_000 },
      }),
    )?.parts,
  ).toEqual([
    { text: 'Review', tone: 'reviewer' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Reviewer', tone: 'reviewer' },
    { text: ' check V1', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: 'npm test', tone: 'textDim' },
  ]);
});

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
      tone: 'warning',
      hint: 'esc back after stop · ctrl+c quit after stop',
      parts: [
        { text: 'Stopping', tone: 'warning' },
        { text: ' T002', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: 'Waiting for processes to exit', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: '0:03', tone: 'textDim' },
      ],
    });
  });

  it('formats the stopping lead clock as h:mm:ss when over an hour', () => {
    expect(
      stopByline(input({ intent: 'stop-now', phase: 'terminating', elapsedMs: 10_314_000 })),
    ).toEqual({
      tone: 'warning',
      hint: 'esc back after stop · ctrl+c quit after stop',
      parts: [
        { text: 'Stopping', tone: 'warning' },
        { text: ' T002', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: 'Waiting for processes to exit', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: '2:51:54', tone: 'textDim' },
      ],
    });
  });

  it('says it is forcing once the grace is spent', () => {
    expect(stopByline(input({ intent: 'stop-now', phase: 'forcing' }))?.parts).toEqual([
      { text: 'Stopping', tone: 'warning' },
      { text: ' T002', tone: 'text' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Forcing remaining processes to exit', tone: 'textDim' },
    ]);
  });

  it('reports a boundary pause as a finish rather than a termination', () => {
    expect(stopByline(input({ intent: 'pause-after-brief', phase: 'requested' }))).toEqual({
      tone: 'warning',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Finishing', tone: 'warning' },
        { text: ' T002', tone: 'text' },
      ],
    });
  });

  it('asks for the answer the pause is waiting on', () => {
    expect(
      stopByline(input({ intent: 'pause-after-brief', phase: 'requested', questionPending: true })),
    ).toEqual({
      tone: 'warning',
      hint: 'Pause requested',
      parts: [
        { text: 'Answer needed', tone: 'warning' },
        { text: ' to finish T002', tone: 'text' },
      ],
    });
  });

  it('names the brief the pause outlived, which the run has just finished', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
    });

    expect(stopByline(paused)).toEqual({
      tone: 'warning',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Finishing', tone: 'warning' },
        { text: ' T003', tone: 'text' },
      ],
    });
  });

  it('names the run when a pause is armed before any brief has finished', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
    });

    expect(
      stopByline(paused)
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Finishing the run');
  });

  // In a real run, with a pause armed, the ten-minute boundary suite read `Finishing the run`.
  it('names the full-suite stage a pause waits on, with its command and its clock', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
      suite: { moment: 'pre-review', command: 'npm test', elapsedMs: 602_000 },
    });

    expect(stopByline(paused)).toEqual({
      tone: 'warning',

      clock: '10:02',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Pre-review suite', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
    });
  });

  it('formats the suite clock as h:mm:ss when over an hour', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      currentTaskId: null,
      finishedTaskId: 'T003',
      suite: { moment: 'pre-review', command: 'npm test', elapsedMs: 10_314_000 },
    });

    expect(stopByline(paused)).toEqual({
      tone: 'warning',

      clock: '2:51:54',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Pre-review suite', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
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

    expect(stopByline(paused)).toEqual({
      tone: 'warning',

      clock: '0:42',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' check V2', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
    });
  });

  it('keeps the Review prefix while a pause waits on a reviewer check', () => {
    const paused = input({
      intent: 'pause-after-brief',
      phase: 'requested',
      workflowPhase: 'final-review',
      currentTaskId: null,
      suite: { id: 'V1', moment: 'pre-review', command: 'npm test', elapsedMs: 42_000 },
    });
    expect(stopByline(paused)).toEqual({
      tone: 'warning',

      clock: '0:42',
      hint: 'Pause requested; no next brief will start',
      parts: [
        { text: 'Review', tone: 'reviewer' },
        { text: ' · ', tone: 'textDim' },
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' check V1', tone: 'textDim' },
        { text: ' · ', tone: 'textDim' },
        { text: 'npm test', tone: 'textDim' },
      ],
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
      tone: 'warning',
      hint: '⏎ resume · /stop options · esc back to sessions · ctrl+c quit',
      parts: [
        { text: 'Stopped', tone: 'warning' },
        { text: ' at T002', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: 'Partial changes kept', tone: 'textDim' },
      ],
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
      tone: 'warning',
      hint: '⏎ resume · /stop options · esc back to sessions · ctrl+c quit',
      parts: [
        { text: 'Stopped', tone: 'warning' },
        { text: ' before T003', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: '2 of 5 briefs complete', tone: 'textDim' },
      ],
    });
  });

  it('parks at a boundary with no next brief before the review', () => {
    expect(
      stopByline(
        input({
          intent: 'pause-after-brief',
          phase: 'parked',
          parked: { kind: 'boundary', taskId: 'T005' },
          nextTaskId: null,
          passed: 5,
        }),
      ),
    ).toEqual({
      tone: 'warning',
      hint: '⏎ resume · /stop options · esc back to sessions · ctrl+c quit',
      parts: [
        { text: 'Stopped', tone: 'warning' },
        { text: ' before the review', tone: 'text' },
        { text: ' · ', tone: 'textDim' },
        { text: '5 of 5 briefs complete', tone: 'textDim' },
      ],
    });
  });

  it('names the gate a planning stop settled at and claims no changes', () => {
    expect(stopByline(settled({ kind: 'gate', gate: 'plan' }))).toEqual({
      tone: 'warning',
      hint: PARKED_HINT,
      parts: [
        { text: 'Stopped', tone: 'warning' },
        { text: ' at the plan', tone: 'text' },
      ],
    });
  });

  it('names the planner step a stop cut, which changed no files', () => {
    expect(
      stopByline(settled({ kind: 'planner', call: 'tasks' }))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped at the plan');
  });

  it('keeps the partial-changes claim for a brief the stop cut mid-step', () => {
    expect(
      stopByline(settled({ kind: 'brief', taskId: taskId('T003'), attempt: 0 }))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped at T003 · Partial changes kept');
  });

  it('claims no partial changes for a brief the run stopped before', () => {
    expect(
      stopByline(settled({ kind: 'brief', taskId: taskId('T003'), attempt: 0 }, 'boundary'))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped before T003');
  });

  it('names the review when settled at a boundary before the review', () => {
    expect(
      stopByline(settled({ kind: 'review', cycle: 0 }, 'boundary'))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped before the review');
  });

  it('claims kept partial changes only when the cut is mid-step', () => {
    expect(
      stopByline(
        input({
          intent: 'stop-now',
          phase: 'parked',
          parked: null,
          currentTaskId: 'T002',
        }),
      )
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped at T002');
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
      )
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Stopped');
    expect(
      stopByline(input({ intent: 'stop-now', phase: 'parked', currentTaskId: null }))?.parts,
    ).toEqual([{ text: 'Stopped', tone: 'warning' }]);
  });

  // In a real run, after End run the byline called T005 cancelled with its changes kept, while
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
    expect(
      stopByline(input({ intent: 'end-run', phase: 'terminating' }))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Ending run · Waiting for processes to exit · 0:03');
  });

  it('formats the ending run lead clock as h:mm:ss when over an hour', () => {
    expect(
      stopByline(input({ intent: 'end-run', phase: 'terminating', elapsedMs: 10_314_000 }))
        ?.parts.map((part) => part.text)
        .join(''),
    ).toBe('Ending run · Waiting for processes to exit · 2:51:54');
  });

  it('says it is saving the session on the way out', () => {
    expect(stopByline(input({ intent: 'quit', phase: 'terminating' }))).toEqual({
      tone: 'warning',
      hint: 'Stopping processes and saving session',
      parts: [{ text: 'Quitting', tone: 'warning' }],
    });
  });
});

it('does not claim a live process during cleanup or persistence', () => {
  const byline = stopByline(input({ intent: 'stop-now', phase: 'settling' }));
  expect(byline?.parts).toEqual([
    { text: 'Stopping', tone: 'warning' },
    { text: ' T002', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Finishing cleanup and saving', tone: 'textDim' },
    { text: ' · ', tone: 'textDim' },
    { text: '0:03', tone: 'textDim' },
  ]);
  expect(byline?.parts.map((part) => part.text).join('')).toContain('Finishing cleanup and saving');
  expect(byline?.parts.map((part) => part.text).join('')).not.toContain('processes');
});

it('reports the actual cleanup failure and the retry action', () => {
  expect(stopByline(input({ intent: 'stop-now', phase: 'failed', error: 'Disk full' }))).toEqual({
    tone: 'error',
    hint: '/stop to retry',
    parts: [
      { text: 'Stop failed', tone: 'error' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Disk full', tone: 'text' },
    ],
  });
});

it('keeps separators inside a cleanup failure dim and the cause in text', () => {
  expect(
    stopByline(input({ intent: 'stop-now', phase: 'failed', error: 'Disk full · draft.json' }))
      ?.parts,
  ).toEqual([
    { text: 'Stop failed', tone: 'error' },
    { text: ' · ', tone: 'textDim' },
    { text: 'Disk full', tone: 'text' },
    { text: ' · ', tone: 'textDim' },
    { text: 'draft.json', tone: 'text' },
  ]);
});

it.each([60, 120])('preserves stop span tones through the footer at %i columns', (cols) => {
  const byline = stopByline(input({ intent: 'stop-now', phase: 'terminating' }));
  if (byline === null) throw new Error('Expected a stop byline');
  const parts = buildInputFooterByline({
    cols,
    lead: byline.parts,
    hintText: byline.hint,
    queuedText: null,
  });
  expect(parts.slice(0, 2)).toEqual([
    { text: 'Stopping', tone: 'warning' },
    { text: ' T002', tone: 'text' },
  ]);
  expect(parts.find((part) => part.text.startsWith('Waiting for processes'))?.tone).toBe('textDim');
  expect(parts.filter((part) => part.text === ' · ').every((part) => part.tone === 'textDim')).toBe(
    true,
  );
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

describe('stopPoint', () => {
  it.each([
    [
      { kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const,
      'boundary' as const,
      'before T003',
    ],
    [
      { kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const,
      'mid-step' as const,
      'at T003',
    ],
    [{ kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const, undefined, 'at T003'],
    [{ kind: 'review', cycle: 0 } as const, 'boundary' as const, 'before the review'],
    [{ kind: 'review', cycle: 0 } as const, 'mid-step' as const, 'at the review'],
    [{ kind: 'review', cycle: 0 } as const, undefined, 'at the review'],
    [{ kind: 'gate', gate: 'plan' } as const, 'boundary' as const, 'at the plan'],
    [{ kind: 'planner', call: 'plan' } as const, 'boundary' as const, 'at the plan'],
  ])('phrases %o with cut %s as %s', (step, cut, expected) => {
    expect(stopPoint(step, cut)).toBe(expected);
  });
});
