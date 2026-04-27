import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeBusRecorder, makeCallbacks, makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createValidator } from '../validation.js';
import type { WorkflowSinks } from '../types.js';
import { runTasksAndReview } from './phases.js';

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('run-phases-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-phases';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeImplState(tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return state;
}

describe('runTasksAndReview', () => {
  it('does not run final review when the task loop stops before completion', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/too-large.ts' });
    const state = makeImplState([task]);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: { commitStrategy: 'none' } }),
      implementerProfiles: {
        profiles: {
          tiny: {
            kind: 'api' as const,
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny',
            contextLength: 1,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find(event => event.type === 'workflow_complete')).toBeUndefined();
    expect(result.summary.totalTasks).toBe(1);
  });
});
