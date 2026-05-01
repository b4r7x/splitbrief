import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig, makeNoValidationConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createValidator } from '../validation.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import { runTaskLoop } from './loop.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };
const TEST_SINKS: WorkflowSinks = { setAbortHandler: () => {}, setQueueHandler: () => {} };
const TEST_VALIDATOR = createValidator();
const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

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
  callbackOverrides: Parameters<typeof makeCallbacks>[0] = {},
): WorkflowContext {
  const { callbacks } = makeCallbacks(callbackOverrides);
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
    createTestGitRepo(projectDir);
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

  it('taskReview failed emits a recovery-required review gate with task metadata', async () => {
    const projectDir = createTempDir('task-loop-recovery');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-task-loop-recovery';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T003', title: 'Split large task', file: 'src/large.ts' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ implement: vi.fn() });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWorkflowContext(projectDir, sessionId, implementer, bus, {
        implementer: { contextLength: 1 },
        workflow: { taskReview: 'failed' },
      }, {
        onTaskReviewNeeded: async () => ({ action: 'continue' }),
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(events.find(event => event.type === 'task_review_needed')).toMatchObject({
      type: 'task_review_needed',
      taskId: 'T003',
      taskTitle: 'Split large task',
      status: 'recovery-required',
      validation: expect.objectContaining({ passed: false }),
      recovery: expect.objectContaining({ reason: 'context-overflow' }),
      availableCommands: ['continue', 'redo', 'edit-notes', 'revise-plan', 'abort'],
    });
  });

  it('taskReview failed reviews task-affecting user edit recovery stop points', async () => {
    const projectDir = createTempDir('task-loop-recovery');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-task-loop-recovery';
    ensureSessionDir(projectDir, sessionId);

    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const setup = makeTask({ id: 'T003', title: 'Setup task', file: 'src/setup.ts' });
    const conflict = makeTask({ id: 'T004', title: 'Respect edits', file: 'src/conflict.ts' });
    const state = implementingState([setup, conflict]);
    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ projectDir: runDir }: { projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        writeFileSync(join(runDir, 'src/setup.ts'), 'export const setup = true;\n');
        writeFileSync(join(projectDir, 'src/conflict.ts'), 'user edit');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks({
      onUserEditConflict: vi.fn().mockResolvedValue('regenerate-rebase'),
      onTaskReviewNeeded: async () => ({ action: 'continue' }),
    });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { ...defaultWorkflow, taskReview: 'failed' } }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T003',
    });
    expect(events.find(event => event.type === 'task_review_needed')).toMatchObject({
      type: 'task_review_needed',
      taskId: 'T003',
      taskTitle: 'Setup task',
      status: 'recovery-required',
      filesTouched: expect.arrayContaining(['src/conflict.ts']),
      recovery: expect.objectContaining({ reason: 'user-edit-conflict' }),
    });
  });

  it('creates a durable dependency-blocked recovery issue instead of auto-skipping', async () => {
    const projectDir = createTempDir('task-loop-recovery');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
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
