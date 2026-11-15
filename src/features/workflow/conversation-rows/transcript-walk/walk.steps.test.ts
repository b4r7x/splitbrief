import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections } from '../../../../core/sections/group.js';
import { taskId } from '../../../../core/schemas/task.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../core/sessions/workspace-notice.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { makePlannerHeartbeat } from '#testing/helpers/events/planner.js';
import { makeRunnerCallActivity } from '#testing/helpers/events/runner-call.js';
import { makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import type { TranscriptWalkStep } from './types.js';
import { walkTranscript } from './walk.js';

// Each block pins one step of the walk: what the passes over the whole log hide, what a section
// opens and closes, and what one event joins, opens or yields.

const walk = (events: EngineEvent[]): TranscriptWalkStep[] => [
  ...walkTranscript(groupEventsIntoSections(events)),
];
const kinds = (events: EngineEvent[]) => walk(events).map((step) => step.kind);
const rowEvents = (events: EngineEvent[]) =>
  walk(events).flatMap((step) => (step.kind === 'event' ? [step.event] : []));
const recoveries = (events: EngineEvent[]) =>
  walk(events).flatMap((step) => (step.kind === 'recovery' ? [step.recovery] : []));

const HEADLINE = 'Validation failed twice';
const halt: EngineEventOf<'error'> = {
  type: 'error',
  ts: 500,
  phase: 'implementing',
  message: HEADLINE,
};
const prompt = (
  issueId: string,
  ts: number,
  headline = HEADLINE,
): EngineEventOf<'recovery_prompted'> => ({
  type: 'recovery_prompted',
  ts,
  phase: 'implementing',
  issueId,
  reason: 'validation-failed',
  headline,
  files: [],
  affectedTaskIds: [],
  availableActions: ['retry-same-worker', 'switch-seat'],
  recommendedAction: 'retry-same-worker',
  resumeCommand: 'splitbrief continue',
});
const choice = (
  issueId: string,
  ts: number,
  action: 'retry-same-worker' | 'switch-seat' = 'retry-same-worker',
): EngineEventOf<'recovery_action_selected'> => ({
  type: 'recovery_action_selected',
  ts,
  phase: 'implementing',
  issueId,
  reason: 'validation-failed',
  action,
  ...(action === 'switch-seat' && { seat: 'build' }),
});
const outcome = (
  issueId: string,
  ts: number,
  action: 'retry-same-worker' | 'switch-seat' = 'retry-same-worker',
): EngineEventOf<'recovery_resolved'> => ({
  type: 'recovery_resolved',
  ts,
  phase: 'implementing',
  issueId,
  reason: 'validation-failed',
  action,
  ...(action === 'switch-seat' && { seat: 'build' }),
  outcome: 'continued',
});
const seatSwitch = (
  ts: number,
  overrides: Partial<EngineEventOf<'seat_switched'>> = {},
): EngineEventOf<'seat_switched'> => ({
  type: 'seat_switched',
  ts,
  phase: 'implementing',
  seat: 'build',
  from: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
  to: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
  cause: 'validation-failed',
  auto: false,
  configRevision: 'test-revision',
  ...overrides,
});
const note = (ts: number, text = 'A separate update.'): EngineEvent => ({
  type: 'planner_text',
  ts,
  phase: 'implementing',
  text,
});
const message = (ts: number): EngineEvent => ({
  type: 'user_message',
  ts,
  phase: 'implementing',
  text: 'Use the other model.',
});
const activity = (
  callId: string,
  ts: number,
  phase: EngineEventOf<'runner_call_activity'>['phase'] = 'implementing',
) => makeRunnerCallActivity({ callId, ts, phase, activityId: `${callId}:${ts}` });
const reviewCheck = (id: string, ts: number): EngineEventOf<'full_suite'> => ({
  type: 'full_suite',
  ts,
  phase: 'final-review',
  status: 'done',
  id,
  command: `npm test -- ${id}`,
  moment: 'pre-review',
  passed: true,
});
const reviewChecks = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => reviewCheck(`K${from + index}`, from + index));
const T001 = taskId('T001');
const header = makeTaskStart({ taskId: T001, ts: 100, tool: 'opencode', model: 'deepseek' });
const done = makeTaskComplete({ taskId: T001, ts: 9_000 });

describe('walkTranscript: the passes over the whole log', () => {
  const kept = (ts: number): EngineEventOf<'warning'> => ({
    type: 'warning',
    ts,
    phase: 'implementing',
    message: 'Your work is kept for Continue.',
    category: WORKSPACE_NOTICE_CATEGORY,
    code: WORKSPACE_KEPT_CODE,
  });
  const resumed = (ts: number, cause?: 'seat-change'): EngineEventOf<'workflow_resumed'> => ({
    type: 'workflow_resumed',
    ts,
    phase: 'implementing',
    ...(cause !== undefined && { cause }),
  });
  const parked = (ts: number, cause?: 'seat-change'): EngineEventOf<'turn_interrupted'> => ({
    type: 'turn_interrupted',
    ts,
    phase: 'implementing',
    source: 'user',
    at: 'boundary',
    step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
    ...(cause !== undefined && { cause }),
  });
  const cancelled: EngineEvent = {
    type: 'workflow_cancelled',
    ts: 1_500,
    phase: 'implementing',
    reason: 'user_cancelled',
  };

  it('shows the later of two kept-workspace notices with no continue between them', () => {
    const later = kept(1_200);
    expect(rowEvents([kept(1_000), later])).toEqual([later]);
  });

  it('drops only the one resume that a recovery answer started', () => {
    const answered = resumed(3_000);
    const later = resumed(4_000);
    expect(rowEvents([choice('i-1', 2_000), answered, later])).toEqual([later]);
  });

  it('keeps a stop that was not a crew change when a crew change resumes the run', () => {
    const stop = parked(1_000);
    expect(rowEvents([stop, resumed(1_100, 'seat-change')])).toEqual([stop]);
  });

  it('keeps a crew change park that a cancel follows before the resume', () => {
    const park = parked(1_000, 'seat-change');
    expect(rowEvents([park, cancelled, resumed(2_000, 'seat-change')])).toEqual([park, cancelled]);
  });

  it('keeps a crew change park that a plain continue ended', () => {
    const park = parked(1_000, 'seat-change');
    const continued = resumed(2_000);
    expect(rowEvents([park, continued, resumed(3_000, 'seat-change')])).toEqual([park, continued]);
  });
});

describe('walkTranscript: the flush of what is open', () => {
  it('yields an open batch once, before the row that closes it', () => {
    const read = activity('call-a', 1_000);
    const row = note(2_000);
    expect(walk([read, row])).toEqual([
      {
        kind: 'activity-batch',
        batch: { callId: 'call-a', firstIndex: 0, events: [read], lastEvent: read },
        callEnded: false,
      },
      { kind: 'event', event: row, globalIndex: 1 },
    ]);
  });

  it('marks the batch of a call that a stop ended', () => {
    const read = activity('call-a', 1_000);
    const stop: EngineEvent = {
      type: 'turn_interrupted',
      ts: 2_000,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
    };
    expect(walk([read, stop])[0]).toMatchObject({ kind: 'activity-batch', callEnded: true });
  });

  it('gives a batch, a recovery and its switch in a settled brief the section they belong to', () => {
    const events: EngineEvent[] = [
      header,
      activity('call-a', 200),
      prompt('i-1', 300, 'Another halt'),
      choice('i-1', 400, 'switch-seat'),
      seatSwitch(500),
      outcome('i-1', 600, 'switch-seat'),
      done,
    ];
    const [section] = groupEventsIntoSections(events);
    const steps = walk(events);
    expect(steps.map((step) => step.kind)).toEqual([
      'settled',
      'activity-batch',
      'event',
      'recovery',
      'event',
    ]);
    for (const step of steps.slice(1)) expect(step).toMatchObject({ settledSection: section });
  });

  it('gives the three check rows of a settled review the section they belong to', () => {
    const review = { phase: 'final-review', scope: 'final', tool: 'claude-code' } as const;
    const run = reviewChecks(3);
    const events: EngineEvent[] = [
      { type: 'review_started', ts: 0, ...review },
      ...run,
      { type: 'review_completed', ts: 10, ...review, verdict: 'pass', duration: 10 },
    ];
    const [section] = groupEventsIntoSections(events);
    const rows = walk(events).filter((step) => step.kind === 'event');
    expect(rows.map((step) => (step.kind === 'event' ? step.event : undefined))).toEqual(
      expect.arrayContaining(run),
    );
    for (const row of rows) expect(row).toMatchObject({ settledSection: section });
  });
});

describe('walkTranscript: what a section opens and closes', () => {
  const resumedOn = (model: string, ts: number) =>
    makeTaskStart({ taskId: T001, ts, tool: 'opencode', model });

  it('marks an earlier header of a brief that a later header on another model replaced', () => {
    const later = resumedOn('kimi', 200);
    const headers = walk([header, note(150), later]).filter(
      (step) => step.kind === 'event' && step.event.type === 'task_started',
    );
    expect(headers).toEqual([
      { kind: 'event', event: header, globalIndex: 0, historicalTaskHeader: true },
      { kind: 'event', event: later, globalIndex: 2 },
    ]);
  });

  it('keeps one header, not marked, for a brief restarted on the same model', () => {
    const restart = resumedOn('deepseek', 200);
    expect(
      walk([header, note(150), restart]).filter(
        (step) => step.kind === 'event' && step.event.type === 'task_started',
      ),
    ).toEqual([{ kind: 'event', event: header, globalIndex: 0 }]);
  });

  it('closes an open batch before the heading of the review after it', () => {
    expect(kinds([header, done, activity('call-a', 9_100), reviewCheck('K1', 9_300)])).toEqual([
      'settled',
      'event',
      'activity-batch',
      'review-heading',
      'event',
    ]);
  });

  it('opens a fold for a prompt in a review, though the halt before the review read the same', () => {
    const reviewPrompt = { ...prompt('i-1', 9_300), phase: 'final-review' } as const;
    const reviewChoice = { ...choice('i-1', 9_400), phase: 'final-review' } as const;
    const started: EngineEvent = {
      type: 'review_started',
      ts: 9_200,
      phase: 'final-review',
      scope: 'final',
      tool: 'claude-code',
    };
    const events: EngineEvent[] = [
      header,
      done,
      { ...halt, ts: 9_100 },
      started,
      reviewPrompt,
      reviewChoice,
    ];
    expect(recoveries(events)).toEqual([
      { firstIndex: 4, issueId: 'i-1', prompted: reviewPrompt, selected: reviewChoice },
    ]);
  });

  it('keeps the one header of a settled brief that its recovery restarted on the same model', () => {
    const events: EngineEvent[] = [
      header,
      prompt('i-1', 200, 'Another halt'),
      choice('i-1', 300),
      outcome('i-1', 400),
      resumedOn('deepseek', 500),
      done,
    ];
    expect(rowEvents(events).filter((event) => event.type === 'task_started')).toEqual([]);
  });

  it('opens a fold for a prompt after a brief that failed, though its last row read the same', () => {
    const failed: EngineEvent = {
      type: 'task_full_fail',
      ts: 600,
      phase: 'implementing',
      taskId: T001,
    };
    const events: EngineEvent[] = [header, halt, failed, prompt('i-1', 700), choice('i-1', 800)];
    expect(rowEvents(events)).toEqual([halt]);
    expect(recoveries(events)).toEqual([
      { firstIndex: 3, issueId: 'i-1', prompted: prompt('i-1', 700), selected: choice('i-1', 800) },
    ]);
  });

  it('shows the header of a brief that runs again after it settled', () => {
    const again = resumedOn('deepseek', 9_500);
    expect(rowEvents([header, done, again])).toEqual([done, again]);
  });
});

describe('walkTranscript: one event', () => {
  it('closes an open batch before an automatic recovery fold', () => {
    const switched = seatSwitch(500, { auto: true });
    const events: EngineEvent[] = [
      activity('call-a', 100),
      prompt('i-1', 200, 'Another halt'),
      choice('i-1', 300, 'switch-seat'),
      switched,
      outcome('i-1', 600, 'switch-seat'),
    ];
    expect(kinds(events)).toEqual(['activity-batch', 'recovery', 'event']);
  });

  it('opens a fold for a prompt right after an automatic fold, though an earlier halt read the same', () => {
    const events: EngineEvent[] = [
      halt,
      prompt('i-1', 600, 'Another halt'),
      prompt('i-2', 650),
      choice('i-1', 700, 'switch-seat'),
      seatSwitch(800, { auto: true }),
      outcome('i-1', 900, 'switch-seat'),
    ];
    expect(recoveries(events).map((recovery) => recovery.issueId)).toEqual(['i-1', 'i-2']);
  });

  it('keeps one batch for the activity of a call around the header of its settled brief', () => {
    const before = activity('call-a', 50);
    const after = activity('call-a', 150);
    const steps = walk([before, header, after, done]);
    expect(steps.filter((step) => step.kind === 'activity-batch')).toEqual([
      expect.objectContaining({
        batch: { callId: 'call-a', firstIndex: 0, events: [before, after], lastEvent: after },
      }),
    ]);
  });

  it('shows no row for the full fail of a settled brief', () => {
    const failed: EngineEvent = {
      type: 'task_full_fail',
      ts: 600,
      phase: 'implementing',
      taskId: T001,
    };
    expect(rowEvents([header, note(300), failed])).toEqual([
      expect.objectContaining({ type: 'planner_text' }),
    ]);
  });

  it('shows the full fail of another brief inside a settled brief', () => {
    const otherFailed: EngineEvent = {
      type: 'task_full_fail',
      ts: 600,
      phase: 'implementing',
      taskId: taskId('T002'),
    };
    expect(rowEvents([header, otherFailed, done])).toEqual([otherFailed, done]);
  });

  it('opens a fold for a prompt after a batch, though the halt before the batch read the same', () => {
    expect(recoveries([halt, activity('call-a', 600), prompt('i-1', 700)])).toHaveLength(1);
  });

  describe('the seat switch of an open fold', () => {
    const events = (switched: EngineEventOf<'seat_switched'>): EngineEvent[] => [
      prompt('i-1', 100),
      choice('i-1', 200, 'switch-seat'),
      switched,
      outcome('i-1', 400, 'switch-seat'),
    ];

    it('joins the fold when it is the seat, the reason and the phase of the choice', () => {
      const switched = seatSwitch(300);
      expect(walk(events(switched))).toEqual([
        {
          kind: 'recovery',
          recovery: {
            firstIndex: 0,
            issueId: 'i-1',
            prompted: prompt('i-1', 100),
            selected: choice('i-1', 200, 'switch-seat'),
            seatSwitch: switched,
            resolved: outcome('i-1', 400, 'switch-seat'),
          },
        },
        { kind: 'event', event: switched, globalIndex: 2 },
      ]);
    });

    it.each([
      ['another seat', { seat: 'review' }],
      ['another phase', { phase: 'final-review' }],
    ] as const)('closes the fold when it is %s', (_, overrides) => {
      const switched = seatSwitch(300, overrides);
      expect(kinds(events(switched))).toEqual(['recovery', 'event', 'recovery']);
    });

    it('closes the fold at a second switch', () => {
      const second = seatSwitch(350);
      const steps = walk([...events(seatSwitch(300)).slice(0, 3), second]);
      expect(steps.map((step) => step.kind)).toEqual(['recovery', 'event', 'event']);
      expect(steps[0]).toMatchObject({ recovery: { seatSwitch: seatSwitch(300) } });
    });

    it('closes the fold at a switch after its outcome', () => {
      const late = seatSwitch(500);
      const steps = walk([
        prompt('i-1', 100),
        choice('i-1', 200, 'switch-seat'),
        outcome('i-1', 400, 'switch-seat'),
        late,
      ]);
      expect(steps).toEqual([
        expect.objectContaining({ kind: 'recovery' }),
        { kind: 'event', event: late, globalIndex: 3 },
      ]);
      expect(steps[0]).not.toMatchObject({ recovery: { seatSwitch: late } });
    });
  });

  describe('a message typed while a fold is open', () => {
    it('closes a fold that has no choice yet', () => {
      expect(kinds([prompt('i-1', 100), message(200), choice('i-1', 300)])).toEqual([
        'recovery',
        'event',
        'recovery',
      ]);
    });

    it('closes a fold that has its outcome, before the rowless event after it', () => {
      const heartbeat = makePlannerHeartbeat({ ts: 500, phase: 'implementing' });
      expect(
        walk([
          prompt('i-1', 100),
          choice('i-1', 200),
          outcome('i-1', 300),
          message(400),
          heartbeat,
        ]).map((step) => (step.kind === 'event' ? step.event.type : step.kind)),
      ).toEqual(['recovery', 'user_message', 'planner_heartbeat']);
    });
  });

  describe('a check run of a review', () => {
    it('closes an open batch before its first check', () => {
      const first = activity('review-call', 0, 'final-review');
      const again = activity('review-call', 10, 'final-review');
      expect(kinds([first, ...reviewChecks(4), again])).toEqual([
        'review-heading',
        'activity-batch',
        'check-group',
        'activity-batch',
      ]);
    });

    it('is the last row for a prompt after it', () => {
      const reviewHalt: EngineEvent = { ...halt, phase: 'final-review' };
      const reviewPrompt: EngineEvent = { ...prompt('i-1', 20), phase: 'final-review' };
      expect(recoveries([reviewHalt, reviewCheck('K1', 10), reviewPrompt])).toHaveLength(1);
    });
  });

  describe('a prompt that restates the halt above it', () => {
    it('opens no fold until its choice, which carries it', () => {
      expect(walk([halt, prompt('i-1', 600), choice('i-1', 700)])).toEqual([
        { kind: 'event', event: halt, globalIndex: 0 },
        {
          kind: 'recovery',
          recovery: {
            firstIndex: 2,
            issueId: 'i-1',
            prompted: prompt('i-1', 600),
            selected: choice('i-1', 700),
            haltAlreadyShown: true,
          },
        },
      ]);
    });

    it('is not carried by the choice of another issue', () => {
      expect(recoveries([halt, prompt('i-1', 600), choice('i-2', 700)])).toEqual([
        { firstIndex: 2, issueId: 'i-2', selected: choice('i-2', 700) },
      ]);
    });

    it('is carried by the first fold of its issue only', () => {
      expect(
        recoveries([
          halt,
          prompt('i-1', 600),
          choice('i-1', 700),
          outcome('i-1', 800),
          choice('i-1', 900),
        ]),
      ).toEqual([
        {
          firstIndex: 2,
          issueId: 'i-1',
          prompted: prompt('i-1', 600),
          selected: choice('i-1', 700),
          resolved: outcome('i-1', 800),
          haltAlreadyShown: true,
        },
        { firstIndex: 4, issueId: 'i-1', selected: choice('i-1', 900) },
      ]);
    });
  });

  it('opens a fold for a prompt after a fold, though the halt before that fold read the same', () => {
    expect(
      recoveries([halt, choice('i-1', 600), outcome('i-1', 700), prompt('i-2', 800)]).map(
        (recovery) => recovery.issueId,
      ),
    ).toEqual(['i-1', 'i-2']);
  });

  it.each([
    ['a choice', [choice('i-1', 100), outcome('i-1', 200)]],
    ['an outcome', [outcome('i-1', 200)]],
  ] as const)('opens a fold at %s with no prompt before it', (_, events) => {
    expect(walk([...events])).toEqual([
      { kind: 'recovery', recovery: expect.objectContaining({ firstIndex: 0, issueId: 'i-1' }) },
    ]);
  });
});
