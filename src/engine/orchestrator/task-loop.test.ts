import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { Config } from '../../core/schemas/config.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks, makePlanner, makeImplementer, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { loadState } from '../../core/state/persistence.js';
import { runTaskLoop } from './task-loop.js';
import type { WorkflowSinks } from './types.js';
import { createValidator } from './validation.js';
import { readRunSnapshotLedger } from '../snapshots/run.js';
import { buildContextOverflowRecoveryIssue } from './recovery.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

const TEST_VALIDATOR = createValidator();

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-loop-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-loop';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function setupSessionOnly(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-loop-test');
  dirs.push(projectDir);
  const sessionId = 'sess-loop';
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

// Validation disabled: keeps us from spawning tsc/eslint/npm-test subprocesses.
const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

describe('runTaskLoop', () => {
  it('task with failed dependency creates dependency-blocked recovery instead of auto-skipping', async () => {
    const { projectDir, sessionId } = setupProject();
    const t1 = makeTask({ id: 'T001', status: 'failed' });
    const t2 = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([t1, t2]);
    // Simulate T001 failed: advance currentTaskIndex past it.
    state = {
      ...state,
      currentTaskIndex: 1,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(events.find((e) => e.type === 'task_skipped')).toBeUndefined();
    expect(result.state.tasks.find((t) => t.id === 'T002')?.status).toBe('pending');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
      affectedTaskIds: ['T001', 'T002'],
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(events.find((e) => e.type === 'recovery_prompted')).toMatchObject({
      type: 'recovery_prompted',
      reason: 'dependency-blocked',
      taskId: 'T002',
    });
  });

  it('happy path: implement → validate pass → commit when commit strategy is per-task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    // The implementer port is a subprocess seam — we fake success via makeImplementer().
    // The implementer produces a file on disk so per-task commit has something to commit.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          workflow: { commitStrategy: 'per-task' },
        }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const taskStart = events.find((e) => e.type === 'task_started');
    expect(taskStart).toBeDefined();
    expect(taskStart).toMatchObject({ type: 'task_started', taskId: 'T001', index: 0, total: 1 });
    const taskComplete = events.find((e) => e.type === 'task_completed');
    expect(taskComplete).toBeDefined();
    expect(taskComplete).toMatchObject({ type: 'task_completed', taskId: 'T001', method: 'local' });
  });

  it('token usage accumulated on state through implementer', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 500, outputTokens: 200 },
      }),
    });

    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.state.tokenUsage.implementerInput).toBe(500);
    expect(result.state.tokenUsage.implementerOutput).toBe(200);
  });

  it('auto.postTask=true causes snapshot_created event after successful task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: { ...makeNoValidationConfig({ workflow: defaultWorkflow }), snapshots: { auto: { postTask: true } } },
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const snapshotEvent = events.find((e) => e.type === 'snapshot_created');
    expect(snapshotEvent).toBeDefined();
    expect(snapshotEvent).toMatchObject({ type: 'snapshot_created', taskIndex: 0 });

    const ledger = await readRunSnapshotLedger(projectDir, sessionId);
    expect(ledger?.accepted).toBe(false);
    expect(ledger?.rejected).toBe(false);
    if (snapshotEvent?.type === 'snapshot_created') {
      expect(ledger?.runSnapshotIds).toContain(snapshotEvent.snapshotId);
    }
  });

  it('unrelated dirty file present before the loop starts does not emit a user-edit conflict', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    writeFileSync(join(projectDir, 'external-change.txt'), 'external edit');

    const onExternalChanges = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks({ onExternalChanges });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onExternalChanges).not.toHaveBeenCalled();
    expect(implementer.implement).toHaveBeenCalled();
    expect(result.state.currentTaskIndex).toBe(1);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('current task dirty file present before the loop starts is treated as baseline worktree state', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/current.ts' });
    const state = makeImplState([task]);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/current.ts'), 'user edit');

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalled();
    expect(result.state.currentTaskIndex).toBe(1);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('future task dirty file present before the loop starts is checkpointed and does not block later tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const currentTask = makeTask({ id: 'T001', file: 'src/current.ts' });
    const futureTask = makeTask({ id: 'T002', file: 'src/future.ts' });
    const state = makeImplState([currentTask, futureTask]);

    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/future.ts'), 'user edit');

    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        writeFileSync(join(projectDir, 'src/current.ts'), 'implementation');
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('routes a task to the selected profile and publishes profile/tool/model metadata', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig({ workflow: defaultWorkflow }),
      implementerProfiles: {
        default: 'local-small',
        profiles: {
          'cheap-large': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 32768,
          },
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 100,
          },
        },
      },
    };
    const selectedImplementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 20, outputTokens: 10 },
      }),
    });
    const defaultImplementer = makeImplementer({ implement: vi.fn() });
    const createProfileImplementer = vi.fn().mockReturnValue(selectedImplementer);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(defaultImplementer.implement).not.toHaveBeenCalled();
    expect(selectedImplementer.implement).toHaveBeenCalledTimes(1);
    expect(createProfileImplementer).toHaveBeenCalledWith(expect.objectContaining({
      implementer: expect.objectContaining({ model: 'qwen-large' }),
    }));
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      tool: 'ollama',
      model: 'qwen-large',
      contextFit: expect.stringMatching(/fits|tight/),
      estimatedTokens: expect.any(Number),
      contextLength: 32768,
      routingReason: expect.stringContaining('Selected cheapest capable profile cheap-large'),
    });
    expect(events.find((event) => event.type === 'task_tokens')).toMatchObject({
      type: 'task_tokens',
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      tool: 'ollama',
      model: 'qwen-large',
      contextFit: expect.stringMatching(/fits|tight/),
      estimatedTokens: expect.any(Number),
      contextLength: 32768,
      currentCodeContextMode: 'none',
      routingReason: expect.stringContaining('Selected cheapest capable profile cheap-large'),
    });
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      tool: 'ollama',
      model: 'qwen-large',
    });
    expect(result.taskBreakdowns[0]).toMatchObject({
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      tool: 'ollama',
      model: 'qwen-large',
      currentCodeContextMode: 'none',
      routingReason: expect.stringContaining('Selected cheapest capable profile cheap-large'),
    });
  });

  it('routes modify tasks using current code refreshed from disk before dispatch', async () => {
    const { projectDir, sessionId } = setupProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const currentCode = Array.from({ length: 1600 }, (_, i) => `export const value${i} = ${i};`).join('\n');
    writeFileSync(join(projectDir, 'src/target.ts'), currentCode);

    const task = makeTask({ id: 'T001', action: 'modify', file: 'src/target.ts' });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig({ workflow: defaultWorkflow }),
      implementerProfiles: {
        default: 'local-small',
        profiles: {
          'cheap-large': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 80_000,
          },
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 10_000,
          },
        },
      },
    };
    const selectedImplementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ task: dispatchedTask }: { task: ReturnType<typeof makeTask> }) => {
        expect(dispatchedTask.currentCode).toBe(currentCode);
        return { success: true, output: 'code', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    });
    const defaultImplementer = makeImplementer({ implement: vi.fn() });
    const createProfileImplementer = vi.fn().mockReturnValue(selectedImplementer);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(defaultImplementer.implement).not.toHaveBeenCalled();
    expect(selectedImplementer.implement).toHaveBeenCalledTimes(1);
    expect(createProfileImplementer).toHaveBeenCalledWith(expect.objectContaining({
      implementer: expect.objectContaining({ model: 'qwen-large' }),
    }));
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      currentCodeContextMode: 'whole-file',
    });
  });

  it('clears stale currentCode before routing and dispatch when the target file is missing', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/missing.ts',
      currentCode: 'export const stale = true;\n',
    });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig({ workflow: defaultWorkflow }),
      implementerProfiles: {
        default: 'local-small',
        profiles: {
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 10_000,
          },
        },
      },
    };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ task: dispatchedTask }: { task: ReturnType<typeof makeTask> }) => {
        expect(dispatchedTask.currentCode).toBeUndefined();
        return { success: true, output: 'code', usage: { inputTokens: 20, outputTokens: 10 } };
      }),
    });
    const createProfileImplementer = vi.fn().mockReturnValue(implementer);
    const setTrackedState = vi.fn();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer: makeImplementer(),
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState,
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(setTrackedState).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.not.objectContaining({ currentCode: expect.any(String) })],
    }));
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      currentCodeContextMode: 'none',
    });
  });

  it('blocks before implementer dispatch when every profile overflows the task prompt', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig({ workflow: defaultWorkflow }),
      implementerProfiles: {
        default: 'tiny-local',
        profiles: {
          'tiny-cloud': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny-cloud',
            costTier: 'cheap',
            contextLength: 10,
          },
          'tiny-local': {
            kind: 'api',
            provider: 'ollama',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny-local',
            costTier: 'local',
            contextLength: 10,
          },
        },
      },
    };
    const implementer = makeImplementer({ implement: vi.fn() });
    const createProfileImplementer = vi.fn();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(createProfileImplementer).not.toHaveBeenCalled();
    expect(result.state.phase).toBe('implementing');
    expect(result.state.currentTaskIndex).toBe(0);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T001',
      availableActions: ['planner-split-rebase', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('Ask the planner to split the task'),
    });
  });

  it('dispatches each task as a separate implementer call without prior task continuation text', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(implementer.implement).toHaveBeenNthCalledWith(1, expect.objectContaining({
      task: expect.objectContaining({ id: 'T001' }),
      continuationPrompt: undefined,
    }));
    expect(implementer.implement).toHaveBeenNthCalledWith(2, expect.objectContaining({
      task: expect.objectContaining({ id: 'T002' }),
      continuationPrompt: undefined,
    }));
    expect(result.state.currentTaskIndex).toBe(2);
  });

  it('does not classify previous task output as a user edit in sequential commitStrategy none runs', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/first.ts' });
    const second = makeTask({ id: 'T002', file: 'src/second.ts' });
    const state = makeImplState([first, second]);
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async ({ task }: { task: ReturnType<typeof makeTask> }) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(join(projectDir, task.file), `implementation for ${task.id}`);
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(events.find((event) => event.type === 'paused_external_changes')).toBeUndefined();
  });

  it('asks about a future task edit before it becomes a current-task conflict', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/current.ts' });
    const second = makeTask({ id: 'T002', action: 'modify', file: 'src/future.ts' });
    const state = makeImplState([first, second]);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ task, projectDir: runDir }: { task: ReturnType<typeof makeTask>; projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        if (task.id === 'T001') {
          writeFileSync(join(runDir, 'src/current.ts'), 'export const current = true;\n');
          writeFileSync(join(projectDir, 'src/future.ts'), 'export const userEdit = true;\n');
        } else {
          writeFileSync(join(runDir, 'src/future.ts'), 'export const future = true;\n');
        }
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const onUserEditConflict = vi.fn().mockResolvedValue('continue-unrelated');
    const { callbacks } = makeCallbacks({ onUserEditConflict });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.state.currentTaskIndex).toBe(2);
    expect(onUserEditConflict).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'future-task-stale-input',
      files: ['src/future.ts'],
      affectedTaskIds: ['T002'],
      currentTaskId: 'T001',
    }));
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'continue-unrelated',
      conflict: {
        kind: 'future-task-stale-input',
        files: ['src/future.ts'],
        affectedTaskIds: ['T002'],
        currentTaskId: 'T001',
      },
    });
  });

  it('pauses explicitly when the user chooses regenerate-rebase for a future stale edit', async () => {
    const { projectDir, sessionId } = setupProject();
    const first = makeTask({ id: 'T001', file: 'src/current.ts' });
    const second = makeTask({ id: 'T002', action: 'modify', file: 'src/future.ts' });
    const state = makeImplState([first, second]);
    mkdirSync(join(projectDir, 'src'), { recursive: true });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async ({ task, projectDir: runDir }: { task: ReturnType<typeof makeTask>; projectDir: string }) => {
        mkdirSync(join(runDir, 'src'), { recursive: true });
        if (task.id === 'T001') {
          writeFileSync(join(runDir, 'src/current.ts'), 'export const current = true;\n');
          writeFileSync(join(projectDir, 'src/future.ts'), 'export const userEdit = true;\n');
        } else {
          writeFileSync(join(runDir, 'src/future.ts'), 'export const future = true;\n');
        }
        return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
      }),
    });
    const onUserEditConflict = vi.fn().mockResolvedValue('regenerate-rebase');
    const { callbacks } = makeCallbacks({ onUserEditConflict });
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS, validator: TEST_VALIDATOR, bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.state.phase).toBe('implementing');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
      affectedTaskIds: ['T001', 'T002'],
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'user-edit-conflict',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'paused_external_changes')).toMatchObject({
      type: 'paused_external_changes',
      selectedAction: 'regenerate-rebase',
      conflict: { kind: 'future-task-stale-input', files: ['src/future.ts'], affectedTaskIds: ['T002'] },
    });
    expect(events.find((event) => event.type === 'warning')).toMatchObject({
      type: 'warning',
      message: expect.stringContaining('regenerate/rebase'),
    });
  });

  it('stops immediately on resume when pending recovery already exists', async () => {
    const { projectDir, sessionId } = setupSessionOnly();
    const task = makeTask({ id: 'T001' });
    const state = {
      ...makeImplState([task]),
      pendingRecovery: buildContextOverflowRecoveryIssue({
        task,
        phase: 'implementing',
        createdAt: '2026-04-28T12:00:00.000Z',
      }),
    };
    const implementer = makeImplementer({ implement: vi.fn() });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks: makeCallbacks().callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toEqual(state.pendingRecovery);
  });

  it('persists budget pause recovery after a task boundary', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: {
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-chat',
          },
          workflow: { ...defaultWorkflow, maxBudget: 1.5, budgetPauseThreshold: 0.3 },
        }),
        callbacks: makeCallbacks().callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'budget-paused',
      availableActions: ['continue', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery?.reason).toBe('budget-paused');
  });

  it('persists budget exceeded recovery without ordinary continue', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });

    const result = await runTaskLoop({
      wctx: {
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: {
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-chat',
          },
          workflow: { ...defaultWorkflow, maxBudget: 0.1 },
        }),
        callbacks: makeCallbacks().callbacks,
        context: defaultContext,
        planner: makePlanner(),
        implementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: TEST_VALIDATOR,
        bus: makeBusRecorder().bus,
      },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'budget-exceeded',
      availableActions: ['pause-run', 'abort-workflow'],
    });
    expect(result.state.pendingRecovery?.availableActions).not.toContain('continue');
    expect(loadState(projectDir, sessionId)?.pendingRecovery?.reason).toBe('budget-exceeded');
  });
});
