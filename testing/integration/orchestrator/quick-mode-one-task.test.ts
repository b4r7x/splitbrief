import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { getCompletedTaskIds } from '../../../src/core/state/selectors.js';
import { buildSummary } from '../../../src/engine/orchestrator/summary.js';
import { runTaskLoop } from '../../../src/engine/orchestrator/task/loop.js';
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

const META = makeWorkflowMetadata('quick');
const dirs: string[] = [];

beforeEach(() => resetAllStores());
afterEach(() => {
  while (dirs.length) cleanupTempDir(dirs.pop() as string);
});

describe('quick-mode one-task workflow', () => {
  it('emits task-complete, records completedByLocal=1, and persists state.json on disk', async () => {
    const projectDir = createTempDir('orch-int-quick');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-quick';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    let state = createInitialState('add hello');
    state = transition(state, { type: 'START' });
    state = transition(state, { type: 'START_QUICK', tasks: [task] });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeNoValidationConfig({
      workflow: { commitStrategy: 'none', maxRetries: 1, mode: 'quick' },
    });
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 40, outputTokens: 20 },
      }),
    });

    const { state: finalState, taskBreakdowns } = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        planner: makePlanner(),
        implementer,
        context: defaultContext,
        metadata: META,
        sinks: TEST_WORKFLOW_SINKS,
        validator: createValidator(),
        bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({
      taskId: 'T001',
      method: 'local',
    });
    expect(getCompletedTaskIds(finalState)).toEqual(['T001']);
    expect(existsSync(join(sessionDir(projectDir, sessionId), STATE_FILE))).toBe(true);

    const summary = buildSummary({
      feature: 'add hello',
      state: finalState,
      startTime: Date.now() - 1000,
      taskBreakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(summary.completedByLocal).toBe(1);
    expect(summary.totalTasks).toBe(1);
  });
});
