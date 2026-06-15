import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { Config } from '../../../core/schemas/config.js';
import type { RetryOptions } from '../../implementers/types.js';
import type { WorkflowSinks } from '../types.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots.js';
import { createValidator } from '../validation.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runRetryStep } from './step.js';
import type { RetryInvokeArgs } from './types.js';
import { validateAndCommit } from './validate-and-commit.js';

const TEST_METADATA = {
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
  mode: 'standard',
} as const;

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
  const projectDir = createTempDir('retry-step-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-retry-step';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function configWithProfiles(): Config {
  return {
    ...makeNoValidationConfig({
      approval: { enabled: false, feedRejectionsToPlanner: true },
      workflow: { commitStrategy: 'none' },
    }),
    implementerProfiles: {
      default: 'local-small',
      profiles: {
        'cheap-large': {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
          costTier: 'cheap',
          contextLength: 128_000,
        },
        'local-small': {
          kind: 'api',
          provider: 'ollama',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen-small',
          costTier: 'local',
          contextLength: 8_192,
        },
      },
    },
  };
}

describe('runRetryStep', () => {
  it('passes the workflow abort signal to retry invocation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T000', file: 'src/signal.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const controller = new AbortController();
    const invokeRetry = vi.fn().mockResolvedValue({ success: false, error: 'still failing' });

    await runRetryStep({
      ctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
        taskStartSnapshot,
        dependsOnFiles: [],
        signal: controller.signal,
      },
      task,
      state,
      lastError: 'validation failed',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      invokeRetry,
    });

    expect(invokeRetry).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('passes the staged sandbox env to retry invocation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T010', file: 'src/sandbox.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const invokeRetry = vi.fn().mockImplementation(async (args: RetryInvokeArgs) => {
      expect(args.projectDir).not.toBe(projectDir);
      expect(args.fileIgnoreProjectDir).toBe(projectDir);
      expect(args.sandboxEnv?.HOME?.startsWith(args.projectDir)).toBe(true);
      expect(existsSync(args.sandboxEnv?.HOME ?? '')).toBe(true);
      return { success: false, error: 'still failing' };
    });

    await runRetryStep({
      ctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
        taskStartSnapshot,
        dependsOnFiles: [],
      },
      task,
      state,
      lastError: 'validation failed',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      invokeRetry,
    });

    expect(invokeRetry).toHaveBeenCalledOnce();
  });

  it('does not commit retry results when the signal aborts during validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T011', file: 'src/abort.ts' });
    const state = makeImplState([task]);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const controller = new AbortController();
    const validator = {
      primeBaseline: vi.fn().mockResolvedValue(undefined),
      runValidation: vi.fn().mockImplementation(async () => {
        controller.abort(new DOMException('The user aborted a request.', 'AbortError'));
        return [{ stage: 'test' as const, passed: true }];
      }),
    };

    const result = await validateAndCommit({
      ctx: {
        projectDir,
        sessionId,
        config: configWithProfiles(),
        callbacks,
        bus,
        planner: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator,
        taskStartSnapshot,
        dependsOnFiles: [],
        signal: controller.signal,
      },
      task,
      state,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      retryCount: 1,
      preApprovedChangedFiles: [task.file],
    });

    expect(result).toMatchObject({
      completed: false,
      blockedReason: 'aborted',
      validationResults: [{ stage: 'test', passed: true }],
    });
  });

  it('uses an overridden implementer profile for retry execution and completion metadata', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/profile.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const defaultRetry = async () => {
      throw new Error('default implementer should not handle an overridden retry');
    };
    const overrideRetry = async ({ config: retryConfig, error, attempt, kind }: RetryOptions) => {
      const implementer = retryConfig.implementer;
      return {
        success:
          implementer.kind === 'api' &&
          implementer.provider === 'deepseek' &&
          implementer.model === 'deepseek-chat' &&
          error === 'validation failed' &&
          attempt === 1 &&
          kind === 'local',
        output: 'fixed',
        usage: { inputTokens: 12, outputTokens: 6 },
      };
    };
    const defaultImplementer = makeImplementer({ retry: defaultRetry });
    const overrideImplementer = makeImplementer({ retry: overrideRetry });
    const createProfileImplementer = () => overrideImplementer;

    const outcome = await runRetryStep({
      ctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        context: defaultContext,
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
        taskStartSnapshot,
        dependsOnFiles: [],
      },
      task,
      state,
      lastError: 'validation failed',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      profileOverride: 'cheap-large',
      invokeRetry: ({
        task: retryTask,
        lastError,
        attempts,
        projectDir: retryProjectDir,
        config: retryConfig,
        implementer,
      }) =>
        implementer.retry({
          task: retryTask,
          projectDir: retryProjectDir,
          config: retryConfig,
          context: defaultContext,
          error: lastError,
          attempt: attempts,
          kind: 'local',
          onOutput: () => {},
          phase: state.phase,
        }),
    });

    expect(outcome.result).toEqual({ completed: true, method: 'local', attempts: 1 });
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
      method: 'local',
      implementerProfile: 'cheap-large',
      tool: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
    });
  });

  it('throws when profileOverride points to a non-existent profile', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T002', file: 'src/missing.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const defaultImplementer = makeImplementer();

    await expect(
      runRetryStep({
        ctx: {
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner(),
          context: defaultContext,
          implementer: defaultImplementer,
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
          validator: createValidator(),
          taskStartSnapshot,
          dependsOnFiles: [],
        },
        task,
        state,
        lastError: 'validation failed',
        attempts: 1,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'retry failed',
        profileOverride: 'nonexistent-profile',
        invokeRetry: ({
          implementer,
          task: retryTask,
          lastError,
          attempts,
          projectDir: retryProjectDir,
          config: retryConfig,
        }) =>
          implementer.retry({
            task: retryTask,
            projectDir: retryProjectDir,
            config: retryConfig,
            context: defaultContext,
            error: lastError,
            attempt: attempts,
            kind: 'local',
            onOutput: () => {},
            phase: state.phase,
          }),
      }),
    ).rejects.toThrow(/nonexistent-profile/);
  });

  it('uses the default implementer when profileOverride is undefined', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T003', file: 'src/default.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const defaultRetry = async () => ({
      success: true,
      output: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const defaultImplementer = makeImplementer({ retry: defaultRetry });
    const createProfileImplementer = () => {
      throw new Error('profile implementer should not be created without an override');
    };

    const outcome = await runRetryStep({
      ctx: {
        projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        context: defaultContext,
        implementer: defaultImplementer,
        createImplementer: createProfileImplementer,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: createValidator(),
        taskStartSnapshot,
        dependsOnFiles: [],
      },
      task,
      state,
      lastError: 'validation failed',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      profileOverride: undefined,
      invokeRetry: ({
        implementer,
        task: retryTask,
        lastError,
        attempts,
        projectDir: retryProjectDir,
        config: retryConfig,
      }) =>
        implementer.retry({
          task: retryTask,
          projectDir: retryProjectDir,
          config: retryConfig,
          context: defaultContext,
          error: lastError,
          attempt: attempts,
          kind: 'local',
          onOutput: () => {},
          phase: state.phase,
        }),
    });

    expect(outcome.result).toEqual({ completed: true, method: 'local', attempts: 1 });
  });
});
