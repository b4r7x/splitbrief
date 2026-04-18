import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { handleRetryAndEscalation } from '../../../src/engine/orchestrator/escalation/escalation.js';
import { createValidator } from '../../../src/engine/orchestrator/validation.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeCallbacks, makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';

const SINKS = { setAbortHandler: () => {}, setQueueHandler: () => {} };
const META = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' as const };
const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => { while (dirs.length) cleanupTempDir(dirs.pop() as string); });

describe('escalation cascade: local retries exhaust, then hint (tier 1), then full (tier 2)', () => {
  it('emits retry then tier-1 then tier-2 escalate events in order and falls into method=failed when full fails', async () => {
    const projectDir = createTempDir('orch-int-escalate');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-esc';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    let state = createInitialState('feat');
    state = transition(state, { type: 'START', feature: 'feat' });
    state = transition(state, { type: 'RESEARCH_DONE' });
    state = transition(state, { type: 'SPEC_DONE' });
    state = transition(state, { type: 'APPROVE_SPEC' });
    state = transition(state, { type: 'PLAN_DONE', tasks: [task] });
    state = transition(state, { type: 'APPROVE_PLAN' });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks, events } = makeCallbacks();
    // Every implementer retry fails → local retries exhaust → hint/full escalations exercised.
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken', usage: { inputTokens: 5, outputTokens: 5 } }),
    });
    // Hint retry still fails; full escalation also fails → cascade reaches the bottom.
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 30, outputTokens: 10 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir, sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 2, commitStrategy: 'none' } }),
        context: defaultContext, planner, callbacks, implementer,
        metadata: META, sinks: SINKS, validator: createValidator(),
      },
      task, initialError: 'type error', currentState: state,
    });

    const retryEvents = events.filter((e) => e.type === 'retry');
    const escalateEvents = events.filter((e) => e.type === 'escalate');
    const tiers = escalateEvents.map((e) => (e as { tier: number }).tier);

    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
    expect(tiers).toEqual([1, 2]);
    expect(planner.escalateHint).toHaveBeenCalled();
    expect(planner.escalateFull).toHaveBeenCalled();
    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
  });
});
