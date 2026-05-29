import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { handleRetryAndEscalation } from '../../../src/engine/orchestrator/escalation/escalation.js';
import { createValidator } from '../../../src/engine/orchestrator/validation.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  makeWorkflowMetadata,
  TEST_WORKFLOW_SINKS,
} from '#testing/helpers/orchestrator-context.js';

const META = makeWorkflowMetadata('standard');
const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

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
    state = transition(state, { type: 'BRIEFS_READY', tasks: [task] });
    state = transition(state, { type: 'APPROVE_BRIEFS' });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'hint',
        code: null,
        usage: { inputTokens: 30, outputTokens: 10 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 2, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
        validator: createValidator(),
        bus,
      },
      task,
      initialError: 'type error',
      currentState: state,
    });

    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    const escalateEvents = busEvents.filter((e) => e.type === 'escalate');
    const tiers = escalateEvents.map((e) => (e.type === 'escalate' ? e.tier : -1));

    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
    expect(tiers).toEqual([1, 2]);
    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
  });
});
