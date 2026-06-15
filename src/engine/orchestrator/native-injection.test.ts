import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchNativeInjection } from './native-injection.js';
import { createEventBus } from '../events/bus.js';
import type { EngineEvent } from '../events/types.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
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

  it('books the injected turn token usage into planner accumulators and emits a cost update', async () => {
    const { planner } = fauxPlanner();
    planner.injectUserTurn = async () => ({ inputTokens: 120, outputTokens: 40 });

    const events: EngineEvent[] = [];
    const bus = createEventBus();
    bus.subscribe((e) => events.push(e));

    const projectDir = mkdtempSync(join(tmpdir(), 'native-inject-usage-'));
    try {
      let state: WorkflowState = makeImplState([]);
      const before = state.tokenUsage.plannerInput;

      await dispatchNativeInjection({
        message,
        planner,
        projectDir,
        sessionId: 'sess-usage',
        getState: () => state,
        setState: (s) => {
          state = s;
        },
        bus,
      });

      expect(state.tokenUsage.plannerInput).toBe(before + 120);
      expect(state.tokenUsage.plannerOutput).toBe(40);
      expect(events.some((e) => e.type === 'cost_update')).toBe(true);
      expect(events.some((e) => e.type === 'message_injected_native')).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
