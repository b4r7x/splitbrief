import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { runTaskLoop } from './loop.js';
import { buildContextOverflowRecoveryIssue } from '../recovery/builders/task.js';
import type { Config } from '../../../core/schemas/config.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-test',
    sessionId: 'sess-loop',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function setupSessionOnly(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-loop-test');
  dirs.push(projectDir);
  const sessionId = 'sess-loop';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

describe('runTaskLoop', { timeout: 90_000 }, () => {
  it('task with failed dependency creates dependency-blocked recovery instead of auto-skipping', async () => {
    const { projectDir, sessionId } = setupProject();
    const dependency = makeTask({ id: 'T001', status: 'failed' });
    const blocked = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([dependency, blocked]);
    state = {
      ...state,
      currentTaskIndex: 1,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const implementer = makeImplementer({ implement: vi.fn() });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'task_skipped')).toBeUndefined();
    expect(result.state.tasks.find((t) => t.id === 'T002')?.status).toBe('pending');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
      affectedTaskIds: ['T001', 'T002'],
      availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(result.state.pendingRecovery?.affectedTaskIds).toEqual(
      expect.arrayContaining(['T001', 'T002']),
    );
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'dependency-blocked',
      taskId: 'T002',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'dependency-blocked',
        taskId: 'T002',
        availableActions: ['skip-current-task', 'pause-run', 'abort-workflow'],
        recommendedAction: 'pause-run',
      }),
    );
  });

  it('keeps a priced pre-resume taskBreakdown row when re-entering at currentTaskIndex 1', async () => {
    const { projectDir, sessionId } = setupProject();
    const completed = makeTask({ id: 'T001', status: 'failed' });
    const blocked = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const preResumeRow = {
      taskId: taskId('T001'),
      taskTitle: 'pre-resume task',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
      tool: 'deepseek',
      model: 'deepseek-chat',
    };
    let state = makeImplState([completed, blocked], {
      currentTaskIndex: 1,
      taskBreakdowns: [preResumeRow],
    });
    state = {
      ...state,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const implementer = makeImplementer({ implement: vi.fn() });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        callbacks,
        implementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.taskBreakdowns).toContainEqual(preResumeRow);
    expect(result.taskBreakdowns.filter((row) => row.taskId === taskId('T001'))).toHaveLength(1);
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
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny-cloud',
            costTier: 'cheap',
            contextLength: 10,
          },
          'tiny-local': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer,
        createImplementer: createProfileImplementer,
        bus,
      }),
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
      availableActions: ['pause-run', 'abort-workflow'],
      recommendedAction: 'pause-run',
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      taskId: 'T001',
    });
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('T001 cannot be routed to an implementer profile'),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'context-overflow',
        taskId: 'T001',
        availableActions: ['pause-run', 'abort-workflow'],
        recommendedAction: 'pause-run',
      }),
    );
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        implementer,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toEqual(state.pendingRecovery);
  });

  it('stops on resume of a paused recovery without re-entering or clearing the issue', async () => {
    const { projectDir, sessionId } = setupSessionOnly();
    const task = makeTask({ id: 'T001' });
    const pausedRecovery = {
      ...buildContextOverflowRecoveryIssue({
        task,
        phase: 'implementing',
        createdAt: '2026-04-28T12:00:00.000Z',
      }),
      status: 'paused' as const,
    };
    const state = { ...makeImplState([task]), pendingRecovery: pausedRecovery };
    const implementer = makeImplementer({ implement: vi.fn() });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: defaultWorkflow }),
        implementer,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toEqual(pausedRecovery);
    expect(result.state.pendingRecovery?.status).toBe('paused');
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: {
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-chat',
          },
          workflow: { ...defaultWorkflow, maxBudget: 1.5, budgetPauseThreshold: 0.25 },
        }),
        implementer,
      }),
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
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe('budget-paused');
  });

  it('does not re-pause after a budget pause has been acknowledged', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = { ...makeImplState([task]), budgetPauseAcknowledgedAtCost: 0.4 };
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    });

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({
          implementer: {
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-chat',
          },
          workflow: { ...defaultWorkflow, maxBudget: 1.5, budgetPauseThreshold: 0.25 },
        }),
        implementer,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('complete');
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
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
      wctx: makeWctx({
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
        implementer,
      }),
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
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe('budget-exceeded');
  });
});
