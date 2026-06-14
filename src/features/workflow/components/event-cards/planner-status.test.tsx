import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { eventsStore } from '../../../../stores/workflow/events.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import { PlannerStatusCard } from './planner-status.js';

const runningStatus: EngineEventOf<'planner_status'> = {
  type: 'planner_status',
  ts: 1000,
  phase: 'specifying',
  status: 'running',
};

describe('PlannerStatusCard', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
  });

  it('does not decorate the running phase with a heartbeat from a different phase', async () => {
    eventsStore.__testReset({
      events: [
        {
          type: 'planner_heartbeat',
          ts: 900,
          phase: 'researching',
          elapsedMs: 200,
          accumulatedTokens: 42_000,
          phaseHint: 'stale hint from a finished phase',
        },
      ],
    });

    const ui = renderFeature(<PlannerStatusCard event={runningStatus} chrome />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).not.toContain('42');
    expect(frame).not.toContain('stale hint from a finished phase');

    ui.unmount();
  });

  it('decorates the running phase when the latest heartbeat matches that phase', async () => {
    eventsStore.__testReset({
      events: [
        {
          type: 'planner_heartbeat',
          ts: 1100,
          phase: 'specifying',
          elapsedMs: 200,
          accumulatedTokens: 42_000,
          phaseHint: 'live hint for the current phase',
        },
      ],
    });

    const ui = renderFeature(<PlannerStatusCard event={runningStatus} chrome />);
    await tick();
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('tokens');
    expect(frame).toContain('live hint for the current phase');

    ui.unmount();
  });
});
