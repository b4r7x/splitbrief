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
  seat: 'build',
  resetAt: RESET_AT,
  tool: 'OpenAI Codex CLI',
  ...fields,
});
const ended = (fields: Record<string, unknown> = {}) => ({
  type: 'seat_wait_ended',
  seat: 'build',
  ...fields,
});

function fold(events: readonly { type: string }[]): RunView {
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
    expect(reduceRunView(view, { type: 'task_started' })).toBe(view);
  });

  it('is live again when a kept wait starts once more', () => {
    expect(
      fold([started({ wait: SAVED }), ended({ kept: true }), started({ wait: SAVED })]),
    ).toEqual({ seatWait: { tool: 'OpenAI Codex CLI', wait: SAVED, live: true } });
  });
});
