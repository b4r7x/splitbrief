import { expect, it, vi } from 'vitest';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { createSteeringPort } from '../../calls/steering.js';
import { plannerCallbacksContextOf } from './planner-callbacks-context.js';

it('passes the run steering port unchanged to the planner callbacks context', () => {
  const wctx = makeWctx({
    projectDir: '/unused-project',
    sessionId: 'planner-context',
    steering: createSteeringPort(),
    isolation: { open: vi.fn(), acquire: vi.fn(), dispose: vi.fn() },
  });

  expect(plannerCallbacksContextOf(wctx).steering).toBe(wctx.steering);
});
