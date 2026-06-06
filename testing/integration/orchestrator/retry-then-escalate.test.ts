import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { handleRetryAndEscalation } from '../../../src/engine/orchestrator/escalation/handle.js';
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

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let s = createInitialState('feat');
  s = transition(s, { type: 'START' });
  s = transition(s, { type: 'RESEARCH_DONE' });
  s = transition(s, { type: 'SPEC_DONE' });
  s = transition(s, { type: 'APPROVE_SPEC' });
  s = transition(s, { type: 'PLAN_DONE', tasks: [task] });
  s = transition(s, { type: 'BRIEFS_READY', tasks: [task] });
  s = transition(s, { type: 'APPROVE_BRIEFS' });
  return transition(s, { type: 'TASK_SENT' });
}

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('orch-int-retry');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('retry-then-escalate bridge', { timeout: 30_000 }, () => {
  it('two implement failures followed by retry success stays inside local tier with no escalate events', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: 'fail-1',
        usage: { inputTokens: 5, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        success: true,
        output: 'fixed',
        usage: { inputTokens: 20, outputTokens: 10 },
      });
    const implementer = makeImplementer({ retry });

    const { result } = await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 3, commitStrategy: 'none' } }),
        context: defaultContext,
        planner: makePlanner(),
        callbacks,
        implementer,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
        validator: createValidator(),
        bus,
      },
      task: makeTask(),
      initialError: 'type err',
      currentState: makeValidatingState(),
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
    expect(busEvents.filter((e) => e.type === 'escalate')).toEqual([]);
  });

  it('three implement failures exhausts local tier and triggers hint-tier escalate event', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'persistent',
        usage: { inputTokens: 5, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'try X',
        code: null,
        usage: { inputTokens: 40, outputTokens: 20 },
      }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { maxRetries: 3, commitStrategy: 'none' } }),
        context: defaultContext,
        planner,
        callbacks,
        implementer,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
        validator: createValidator(),
        bus,
      },
      task: makeTask(),
      initialError: 'type err',
      currentState: makeValidatingState(),
    });

    expect(busEvents.find((e) => e.type === 'escalate' && e.tier === 1)).toBeDefined();
  });
});
