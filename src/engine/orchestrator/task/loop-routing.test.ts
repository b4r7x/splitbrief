import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeCallbacks,
  makeImplementer,
  makeBusRecorder,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { runTaskLoop } from './loop.js';

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

const defaultWorkflow = { commitStrategy: 'none' as const, maxRetries: 2 };

describe('runTaskLoop', { timeout: 90_000 }, () => {
  it('routes a task to the selected profile and publishes profile/tool/model metadata', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const config: Config = {
      ...makeNoValidationConfig({ workflow: defaultWorkflow }),
      implementerProfiles: {
        default: 'local-small',
        profiles: {
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 100,
          },
          'cheap-large': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 32768,
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
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        allowRepoRunners: true,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(defaultImplementer.implement).not.toHaveBeenCalled();
    expect(selectedImplementer.implement).toHaveBeenCalledTimes(1);
    const cheapLarge = config.implementerProfiles!.profiles['cheap-large']!;
    if (cheapLarge.kind !== 'api') {
      throw new Error('expected api implementer profile');
    }
    expect(createProfileImplementer).toHaveBeenCalledWith(
      expect.objectContaining({
        implementer: {
          kind: cheapLarge.kind,
          provider: cheapLarge.provider,
          service: cheapLarge.service,
          offering: cheapLarge.offering,
          apiBase: cheapLarge.apiBase,
          model: cheapLarge.model,
          contextLength: cheapLarge.contextLength,
        },
      }),
      expect.objectContaining({ publisher: expect.any(Object), allowRepoRunners: true }),
    );
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

  it('uses a one-shot recovery profile override for the resumed task dispatch', async () => {
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
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 32768,
          },
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 32768,
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

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        retryProfileOverride: 'cheap-large',
        retryProfileOverrideTaskId: task.id,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(defaultImplementer.implement).not.toHaveBeenCalled();
    expect(selectedImplementer.implement).toHaveBeenCalledTimes(1);
    expect(createProfileImplementer).toHaveBeenCalledWith(
      expect.objectContaining({
        implementer: expect.objectContaining({ model: 'qwen-large' }),
      }),
      expect.objectContaining({ publisher: expect.any(Object) }),
    );
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      implementerProfile: 'cheap-large',
      model: 'qwen-large',
    });
  });

  it('routes modify tasks using current code refreshed from disk before dispatch', async () => {
    const { projectDir, sessionId } = setupProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const currentCode = Array.from(
      { length: 1600 },
      (_, i) => `export const value${i} = ${i};`,
    ).join('\n');
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
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 80_000,
          },
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 10_000,
          },
        },
      },
    };
    const selectedImplementer = makeImplementer({
      implement: vi
        .fn()
        .mockImplementation(
          async ({ task: dispatchedTask }: { task: ReturnType<typeof makeTask> }) => {
            expect(dispatchedTask.currentCode).toBe(currentCode);
            return { success: true, output: 'code', usage: { inputTokens: 20, outputTokens: 10 } };
          },
        ),
    });
    const defaultImplementer = makeImplementer({ implement: vi.fn() });
    const createProfileImplementer = vi.fn().mockReturnValue(selectedImplementer);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(defaultImplementer.implement).not.toHaveBeenCalled();
    expect(selectedImplementer.implement).toHaveBeenCalledTimes(1);
    expect(createProfileImplementer).toHaveBeenCalledWith(
      expect.objectContaining({
        implementer: expect.objectContaining({ model: 'qwen-large' }),
      }),
      expect.objectContaining({ publisher: expect.any(Object) }),
    );
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
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 10_000,
          },
        },
      },
    };
    const implementer = makeImplementer({
      implement: vi
        .fn()
        .mockImplementation(
          async ({ task: dispatchedTask }: { task: ReturnType<typeof makeTask> }) => {
            expect(dispatchedTask.currentCode).toBeUndefined();
            return { success: true, output: 'code', usage: { inputTokens: 20, outputTokens: 10 } };
          },
        ),
    });
    const createProfileImplementer = vi.fn().mockReturnValue(implementer);
    const setTrackedState = vi.fn();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer: makeImplementer(),
        createImplementer: createProfileImplementer,
        bus,
      }),
      initialState: state,
      setTrackedState,
      setCurrentTask: vi.fn(),
    });

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      currentCodeContextMode: 'none',
    });
  });

  it('blocks before invoking an unavailable selected profile implementer', async () => {
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
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-large',
            costTier: 'cheap',
            contextLength: 32768,
          },
          'local-small': {
            kind: 'api',
            provider: 'ollama',
            service: 'ollama',
            offering: 'local',
            apiBase: 'http://localhost:11434/v1',
            model: 'qwen-small',
            costTier: 'local',
            contextLength: 100,
          },
        },
      },
    };
    const selectedImplementer = makeImplementer({
      isAvailable: vi.fn().mockResolvedValue(false),
      implement: vi.fn(),
    });
    const createProfileImplementer = vi.fn().mockReturnValue(selectedImplementer);
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTaskLoop({
      wctx: makeWctx({
        projectDir,
        sessionId,
        config,
        callbacks,
        implementer: makeImplementer(),
        createImplementer: createProfileImplementer,
        bus,
      }),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.status).toBe('stopped');
    expect(selectedImplementer.implement).not.toHaveBeenCalled();
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'implementation-error',
      taskId: 'T001',
      selectedImplementerProfile: 'cheap-large',
      message: 'T001 selected implementer is unavailable',
      recommendedAction: 'retry-same-worker',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'implementation-error',
        taskId: 'T001',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Selected implementer profile cheap-large'),
      }),
    );
  });

  it('blocks before invoking an unavailable default implementer', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);
    const implementer = makeImplementer({
      isAvailable: vi.fn().mockResolvedValue(false),
      implement: vi.fn(),
    });
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
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'implementation-error',
      taskId: 'T001',
      selectedImplementerProfile: 'default',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'implementation-error',
        taskId: 'T001',
      }),
    );
  });
});
