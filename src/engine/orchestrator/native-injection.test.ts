import { describe, it, expect } from 'vitest';
import { dispatchNativeInjection } from './native-injection.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import type { QueuedMessage } from '../../core/schemas/workflow.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';

const message: QueuedMessage = {
  id: 'msg-1',
  text: 'please continue',
  queuedAt: new Date().toISOString(),
  phase: 'implementing',
  deliveredViaNative: false,
};

describe('dispatchNativeInjection', () => {
  it('publishes a warning instead of silently swallowing an injection failure', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => {
      throw new Error('socket closed');
    };

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));
    const state = makeImplState([]);

    await expect(
      dispatchNativeInjection({
        message,
        planner,
        projectDir: '/tmp/does-not-matter',
        sessionId: 'sess-1',
        getState: () => state,
        setState: () => {},
        bus,
      }),
    ).resolves.toBeUndefined();

    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(events.some((e) => e.type === 'message_injected_native')).toBe(false);
  });
});
