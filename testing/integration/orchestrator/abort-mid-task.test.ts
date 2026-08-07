import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { runTaskLoop } from '../../../src/engine/orchestrator/task/loop.js';
import { createValidator } from '../../../src/engine/orchestrator/validation/run.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makeCopyingIsolation,
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

describe('abort during implementer phase terminates the task loop cleanly', {
  timeout: 90_000,
}, () => {
  it('aborting mid-implement leaves the task un-advanced and emits no task-complete afterwards', async () => {
    const projectDir = createTempDir('orch-int-abort');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-abort';
    ensureSessionDir(projectDir, sessionId);

    let state = createInitialState('feat');
    state = transition(state, { type: 'START' });
    state = transition(state, { type: 'RESEARCH_DONE' });
    state = transition(state, { type: 'SPEC_DONE' });
    state = transition(state, { type: 'APPROVE_SPEC' });
    state = transition(state, {
      type: 'PLAN_DONE',
      tasks: [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })],
    });
    state = transition(state, {
      type: 'BRIEFS_READY',
      tasks: [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })],
    });
    state = transition(state, { type: 'APPROVE_BRIEFS' });

    const controller = new AbortController();
    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();

    // Abort the engine signal while the implementer is "running".
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        controller.abort();
        return {
          success: true,
          output: 'never-validated',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
    });

    const { state: finalState } = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: { maxRetries: 1 } }),
        callbacks,
        planner: makePlanner(),
        implementer,
        context: defaultContext,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
        validator: createValidator(),
        bus,
        signal: controller.signal,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const t002Start = busEvents.find((e) => e.type === 'task_started' && e.taskId === 'T002');
    expect(t002Start).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(finalState.currentTaskIndex).toBeLessThan(finalState.tasks.length);
  });
});
