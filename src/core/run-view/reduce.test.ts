import { describe, expect, it } from 'vitest';
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
