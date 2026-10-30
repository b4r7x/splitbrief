import { describe, it, expect, beforeEach } from 'vitest';
import type { SeatWait } from '../../core/schemas/workflow.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { runViewStore } from './run-view.js';
import { addEvent } from './actions/event.js';
import { markCancellationRequested } from './actions/interrupt.js';
import { loadEvents } from './actions/load.js';
import { resetWorkflow, resetWorkflowHistory } from './actions/reset.js';

const RESET_AT = '2026-10-27T12:00:00.000Z';
const SAVED: SeatWait = {
  seat: 'build',
  resetAt: RESET_AT,
  tool: 'codex',
  kind: 'cli',
  holds: { tool: 'codex', kind: 'cli' },
};

const runStarted: EngineEvent = {
  type: 'workflow_started',
  ts: 1_000,
  phase: 'implementing',
  feature: 'test',
};
const waitStarted: EngineEvent = {
  type: 'seat_wait_started',
  ts: 1_100,
  phase: 'implementing',
  seat: 'build',
  resetAt: RESET_AT,
  tool: 'OpenAI Codex CLI',
  wait: SAVED,
};
const LIVE = { tool: 'OpenAI Codex CLI', wait: SAVED, live: true };

describe('runViewStore', () => {
  beforeEach(() => {
    resetWorkflow();
  });

  it('folds each live event', () => {
    addEvent(runStarted);
    addEvent(waitStarted);
    expect(runViewStore.get().seatWait).toEqual(LIVE);

    addEvent({ type: 'seat_wait_ended', ts: 1_200, phase: 'implementing', seat: 'build' });
    expect(runViewStore.get().seatWait).toBeNull();
  });

  it('folds a replayed log', () => {
    loadEvents([runStarted, waitStarted]);
    expect(runViewStore.get().seatWait).toEqual(LIVE);
  });

  it('takes the end a stop writes after it cancels the run', () => {
    addEvent(runStarted);
    addEvent(waitStarted);
    markCancellationRequested({ ts: 1_150 });
    addEvent({
      type: 'seat_wait_ended',
      ts: 1_200,
      phase: 'implementing',
      seat: 'build',
      kept: true,
    });
    expect(runViewStore.get().seatWait).toEqual({ ...LIVE, live: false });
  });

  it('clears with the run history', () => {
    loadEvents([runStarted, waitStarted]);
    resetWorkflowHistory();
    expect(runViewStore.get().seatWait).toBeNull();
  });
});
