import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import type { StepRef } from '../schemas/run-step.js';
import { taskId } from '../schemas/task.js';
import type { SeatWait } from '../schemas/workflow.js';
import { EMPTY_RUN_VIEW, reduceRunView, type RunView } from './reduce.js';

const RESET_AT = '2026-10-27T12:00:00.000Z';
const SAVED: SeatWait = {
  seat: 'build',
  resetAt: RESET_AT,
  tool: 'codex',
  kind: 'cli',
  holds: { tool: 'codex', kind: 'cli' },
};

const started = (fields: Record<string, unknown> = {}) => ({
  type: 'seat_wait_started',
  ts: 1_000,
  seat: 'build',
  resetAt: RESET_AT,
  tool: 'OpenAI Codex CLI',
  ...fields,
});
const ended = (fields: Record<string, unknown> = {}) => ({
  type: 'seat_wait_ended',
  ts: 2_000,
  seat: 'build',
  ...fields,
});

const taskStarted = (ts: number) => ({
  type: 'task_started',
  ts,
  phase: 'implementing',
  taskId: 'T001',
  title: 'first',
  index: 0,
  total: 1,
  file: 'a.ts',
  action: 'create',
});

function at(type: string, ts: number, phase?: string): { type: string; ts: number } {
  const event = { type, ts, phase };
  return event;
}

function fold(events: readonly { type: string; ts: number }[]): RunView {
  return events.reduce(reduceRunView, EMPTY_RUN_VIEW);
}

describe('reduceRunView seat wait', () => {
  it('sets a live wait from a start that carries the saved wait', () => {
    expect(fold([started({ wait: SAVED })]).seatWait).toEqual({
      tool: 'OpenAI Codex CLI',
      wait: SAVED,
      live: true,
    });
  });

  it('sets a live wait from the seat and reset of a start written before the saved wait', () => {
    expect(fold([started()]).seatWait).toEqual({
      tool: 'OpenAI Codex CLI',
      wait: { seat: 'build', resetAt: RESET_AT },
      live: true,
    });
  });

  it('changes nothing for a start without a tool or with a blank tool', () => {
    const view = fold([started({ wait: SAVED })]);
    expect(reduceRunView(EMPTY_RUN_VIEW, started({ tool: undefined }))).toBe(EMPTY_RUN_VIEW);
    expect(reduceRunView(view, started({ tool: '  ', resetAt: '2026-10-27T13:00:00.000Z' }))).toBe(
      view,
    );
  });

  it('replaces the first wait with a second start', () => {
    const view = fold([
      started({ wait: SAVED }),
      started({ seat: 'review', tool: 'Gemini CLI', resetAt: '2026-10-27T13:00:00.000Z' }),
    ]);
    expect(view.seatWait).toEqual({
      tool: 'Gemini CLI',
      wait: { seat: 'review', resetAt: '2026-10-27T13:00:00.000Z' },
      live: true,
    });
  });

  it('keeps the saved wait, no longer live, when the end says a stop kept it', () => {
    expect(fold([started({ wait: SAVED }), ended({ kept: true })]).seatWait).toEqual({
      tool: 'OpenAI Codex CLI',
      wait: SAVED,
      live: false,
    });
  });

  it('clears the wait on a plain end', () => {
    expect(fold([started({ wait: SAVED }), ended()])).toEqual(EMPTY_RUN_VIEW);
  });

  it('returns the same view for an end with no wait and for an unrelated event', () => {
    expect(reduceRunView(EMPTY_RUN_VIEW, ended({ kept: true }))).toBe(EMPTY_RUN_VIEW);
    const view = fold([started({ wait: SAVED })]);
    expect(reduceRunView(view, { type: 'heartbeat', ts: 3_000 })).toBe(view);
  });

  it('is live again when a kept wait starts once more', () => {
    expect(
      fold([started({ wait: SAVED }), ended({ kept: true }), started({ wait: SAVED })]),
    ).toEqual({
      ...EMPTY_RUN_VIEW,
      seatWait: { tool: 'OpenAI Codex CLI', wait: SAVED, live: true },
    });
  });
});

describe('reduceRunView phase', () => {
  it('moves to the phase an event names and dates each phase once, at its first event', () => {
    const view = fold([
      at('workflow_started', 1_000, 'planning'),
      taskStarted(2_000),
      at('task_validating', 3_000, 'validating-task'),
      taskStarted(4_000),
    ]);

    expect(view.phase).toBe('implementing');
    expect(view.phaseFirstSeen).toEqual({
      planning: 1_000,
      implementing: 2_000,
      'validating-task': 3_000,
    });
  });

  it('dates the phases again from a new run start', () => {
    const view = fold([
      at('workflow_started', 1_000, 'planning'),
      taskStarted(2_000),
      at('workflow_started', 5_000, 'planning'),
    ]);

    expect(view.phase).toBe('planning');
    expect(view.phaseFirstSeen).toEqual({ planning: 5_000 });
  });

  it('does not move for the replay markers, idle, or an event without a phase', () => {
    const view = fold([taskStarted(1_000)]);

    expect(reduceRunView(view, at('replay_started', 2_000, 'planning'))).toBe(view);
    expect(reduceRunView(view, at('replay_complete', 3_000, 'planning'))).toBe(view);
    expect(reduceRunView(view, at('planner_status', 4_000, 'idle'))).toBe(view);
    expect(reduceRunView(view, at('heartbeat', 5_000))).toBe(view);
  });

  it('returns the same view for a phase it already stands in', () => {
    const view = fold([at('task_validating', 1_000, 'validating-task')]);

    expect(reduceRunView(view, at('task_validating', 2_000, 'validating-task'))).toBe(view);
  });
});

describe('reduceRunView halt', () => {
  const issue = makeRecoveryIssue({ id: 'halt-1' });
  const step: StepRef = { kind: 'brief', taskId: taskId('T001'), attempt: 0 };
  const prompted = (fields: Record<string, unknown> = { issue, at: step }) => ({
    type: 'recovery_prompted',
    ts: 1_000,
    ...fields,
  });
  const halted = (): RunView => fold([prompted()]);
  const resolved = (issueId: string) => ({ type: 'recovery_resolved', ts: 2_000, issueId });

  it('holds the halt and the step a prompt names', () => {
    expect(halted().halt).toEqual({ issue, at: step });
  });

  it('changes nothing for a prompt written before the log carried its issue', () => {
    expect(reduceRunView(EMPTY_RUN_VIEW, prompted({}))).toBe(EMPTY_RUN_VIEW);
    expect(reduceRunView(EMPTY_RUN_VIEW, prompted({ issue }))).toBe(EMPTY_RUN_VIEW);
  });

  it('clears the halt when the run resolves it', () => {
    expect(reduceRunView(halted(), resolved('halt-1')).halt).toBeNull();
  });

  it('keeps the halt when the run resolves another one', () => {
    const view = halted();
    expect(reduceRunView(view, resolved('halt-0'))).toBe(view);
  });

  it.each(['workflow_cancelled', 'workflow_complete', 'workflow_started'])(
    'clears the halt on %s',
    (type) => {
      expect(reduceRunView(halted(), { type, ts: 2_000 }).halt).toBeNull();
    },
  );
});

const event = (type: string, ts: number, fields: Record<string, unknown> = {}) => ({
  type,
  ts,
  ...fields,
});

describe('reduceRunView ask', () => {
  const round = [{ id: 'module', type: 'input', text: 'Which module?' }];
  const asked = event('planner_questions_asked', 1_000, { phase: 'planning', questions: round });

  it('holds an asked round until the user sends the next message', () => {
    expect(fold([asked]).questions).toEqual(round);
    expect(fold([asked, event('user_message', 2_000, { text: '' })]).questions).toBeNull();
  });

  it('takes the next round over the first', () => {
    const next = [{ id: 'api', type: 'confirm', text: 'Keep the API?' }];
    const second = event('planner_questions_asked', 2_000, { questions: next });
    expect(fold([asked, second]).questions).toEqual(next);
  });

  it('forgets the round of an earlier run start', () => {
    expect(fold([asked, event('workflow_started', 2_000)]).questions).toBeNull();
  });

  it.each(['plan_approved', 'plan_rejected', 'plan_regenerated', 'workflow_started'])(
    'closes an opened plan card on %s',
    (type) => {
      const opened = fold([event('plan_card_opened', 1_000)]);
      expect(opened.planCard).toBe(true);
      expect(reduceRunView(opened, event(type, 2_000)).planCard).toBe(false);
    },
  );
});

describe('reduceRunView stop', () => {
  const cut = event('turn_interrupted', 1_000, { kept: ['a.ts', 'b.ts'] });

  it('holds the files a stop kept, and none for a stop that kept nothing', () => {
    expect(fold([cut]).stopKept).toEqual(['a.ts', 'b.ts']);
    expect(fold([cut, event('turn_interrupted', 2_000)]).stopKept).toEqual([]);
  });

  it('drops a kept file a reject put back', () => {
    const rejected = event('run_rejected', 2_000, { restored: ['a.ts', 'c.ts'] });
    expect(fold([cut, rejected]).stopKept).toEqual(['b.ts']);
    const view = fold([cut]);
    expect(reduceRunView(view, event('run_rejected', 2_000, { restored: ['c.ts'] }))).toBe(view);
  });

  it('holds the error a failed step stopped on', () => {
    expect(fold([event('run_failed', 1_000, { message: 'Disk full' })]).failure).toBe('Disk full');
  });

  it.each(['workflow_resumed', 'workflow_started'])('clears the stop on %s', (type) => {
    const view = fold([cut, event('run_failed', 1_500, { message: 'Disk full' })]);
    expect(reduceRunView(view, event(type, 2_000))).toMatchObject({ stopKept: [], failure: null });
  });
});

describe('reduceRunView apply', () => {
  it('starts the clock with the Apply and stops it when the Apply ends', () => {
    const started = fold([event('apply_started', 1_000)]);
    expect(started.apply).toEqual({ since: 1_000, until: null });
    expect(reduceRunView(started, event('apply_finished', 4_000)).apply).toEqual({
      since: 1_000,
      until: 4_000,
    });
  });

  it('changes nothing for an end with no start', () => {
    expect(reduceRunView(EMPTY_RUN_VIEW, event('apply_finished', 4_000))).toBe(EMPTY_RUN_VIEW);
  });

  it('forgets the Apply of an earlier run start', () => {
    const view = fold([event('apply_started', 1_000), event('workflow_started', 2_000)]);
    expect(view.apply).toBeNull();
  });
});
