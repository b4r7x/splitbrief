import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createValidator } from './validation.js';
import type { WorkflowContext, WorkflowSinks } from './types.js';
import { runTaskLoop } from './task-loop.js';

vi.mock('../../lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/git.js')>();
  return {
    ...actual,
    getCurrentChangedFiles: vi.fn().mockResolvedValue([]),
  };
});

let dirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeSinks(): WorkflowSinks {
  return { setAbortHandler: () => {}, setQueueHandler: () => {} };
}

function implementingState(tasks: Task[], currentTaskIndex = 0): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return {
    ...state,
    currentTaskIndex,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  };
}

function makeWorkflowContext(
  projectDir: string,
  sessionId: string,
  implementer = makeImplementer(),
  bus = makeBusRecorder().bus,
  configOverrides: Parameters<typeof makeConfig>[0] = {},
): WorkflowContext {
  const { callbacks } = makeCallbacks();
  return {
    projectDir,
    sessionId,
    config: makeConfig({
      ...configOverrides,
      validation: {
        typecheck: false,
        lint: false,
        test: false,
        testCommand: 'noop',
        ...configOverrides?.validation,
      },
      workflow: {
        commitStrategy: 'none',
        maxRetries: 2,
        ...configOverrides?.workflow,
      },
    }),
    callbacks,
    bus,
    planner: makePlanner(),
    implementer,
    context: defaultContext,
    metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
    sinks: makeSinks(),
    validator: createValidator(),
  };
}

describe('runTaskLoop recovery stop points', () => {
  it('creates a durable context-overflow recovery issue before dispatching an implementer', async () => {
    const projectDir = createTempDir('task-loop-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-task-loop-recovery';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T003', file: 'src/large.ts' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWorkflowContext(projectDir, sessionId, implementer, bus, {
        implementer: { contextLength: 1 },
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T003',
      availableActions: ['planner-split-rebase', 'pause-run', 'abort-workflow'],
      recommendedAction: 'planner-split-rebase',
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T003',
    });
    expect(events.some(event => event.type === 'task_started')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_prompted',
      reason: 'context-overflow',
      taskId: 'T003',
      availableActions: ['planner-split-rebase', 'pause-run', 'abort-workflow'],
      recommendedAction: 'planner-split-rebase',
    }));
  });

  it('creates a durable dependency-blocked recovery issue instead of auto-skipping', async () => {
    const projectDir = createTempDir('task-loop-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-task-loop-recovery';
    ensureSessionDir(projectDir, sessionId);

    const dependency = makeTask({ id: 'T001', file: 'src/base.ts', status: 'failed' });
    const blocked = makeTask({ id: 'T002', file: 'src/blocked.ts', dependsOn: ['T001'] });
    const state = implementingState([dependency, blocked], 1);
    const implementer = makeImplementer({ implement: vi.fn() });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWorkflowContext(projectDir, sessionId, implementer, bus),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.tasks[1]?.status).toBe('pending');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(result.state.pendingRecovery?.affectedTaskIds).toEqual(expect.arrayContaining(['T001', 'T002']));
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_prompted',
      reason: 'dependency-blocked',
      taskId: 'T002',
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
      recommendedAction: 'planner-split-rebase',
    }));
  });
});
