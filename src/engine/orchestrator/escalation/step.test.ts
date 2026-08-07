import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { TREES_DIR } from '../../../core/paths.js';
import type { RetryOptions } from '../../implementers/types.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { createChangeDetector } from '../../change-detection.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createRunIsolation } from '../isolation/create.js';
import { createValidator } from '../validation/run.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState } from '../../../core/state/persistence.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';

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
      workflow: {},
    }),
    implementerProfiles: {
      default: 'local-small',
      profiles: {
        'cheap-large': {
          kind: 'api',
          provider: 'deepseek',
          service: 'deepseek',
          offering: 'payg',
          apiBase: 'https://api.deepseek.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
          costTier: 'cheap',
          contextLength: 128_000,
        },
        'local-small': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
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
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
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
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
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

    expect(outcome.result).toEqual({
      completed: true,
      method: 'local',
      attempts: 1,
      acceptance: { accepted: true, exemptStages: [], blockingStages: [] },
    });
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
          isolation: makeCopyingIsolation({ projectDir, sessionId }),
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
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
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

    expect(outcome.result).toEqual({
      completed: true,
      method: 'local',
      attempts: 1,
      acceptance: { accepted: true, exemptStages: [], blockingStages: [] },
    });
  });

  it('retries in the run worktree the failed attempt used, keeping only its promoted work', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T004', file: 'src/shared.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    const promoted = 'export const shared = true;\n';

    try {
      const failed = await isolation.acquire({
        role: 'implementer',
        config,
        writesFiles: 'direct',
      });
      expect(failed.projectDir).toBe(join(projectDir, TREES_DIR, sessionId));

      // What the failed attempt promoted before validation rejected it, and the
      // half-written file the same attempt left behind unpromoted.
      mkdirSync(join(failed.projectDir, 'src'), { recursive: true });
      writeFileSync(join(failed.projectDir, 'src/shared.ts'), promoted);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/shared.ts'), promoted);
      writeFileSync(join(failed.projectDir, 'src/abandoned.ts'), 'export const half = 1;\n');
      failed.cleanup();

      const retryDirs: string[] = [];
      const outcome = await runRetryStep({
        ctx: {
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner(),
          context: defaultContext,
          implementer: makeImplementer({ capabilities: { writesFiles: 'direct' } }),
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
          validator: createValidator(),
          isolation,
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
        invokeRetry: async ({ projectDir: retryDir }) => {
          retryDirs.push(retryDir);
          return { success: true, output: 'fixed', usage: { inputTokens: 10, outputTokens: 5 } };
        },
      });

      expect(retryDirs).toEqual([failed.projectDir]);
      expect(readFileSync(join(failed.projectDir, 'src/shared.ts'), 'utf-8')).toBe(promoted);
      expect(existsSync(join(failed.projectDir, 'src/abandoned.ts'))).toBe(false);
      expect(outcome.result).toMatchObject({ completed: true });
    } finally {
      await isolation.dispose();
    }
  });

  it('completes a retry that rewrites the file the run worktree was already dirty in', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T005', file: 'src/dirty.ts' });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const isolation = createRunIsolation({
      projectDir,
      sessionId,
      strategy: 'worktree',
      onFallback: () => {},
      onRetained: () => {},
    });
    const firstAttempt = 'export const dirty = "written by the attempt that failed";\n';
    const rewritten = 'export const dirty = "rewritten by the retry";\n';

    try {
      // The failed attempt wrote the file and had it promoted, so the linked
      // worktree is already dirty in the very path the retry rewrites. A
      // detector that compares path membership sees nothing new there.
      const failed = await isolation.acquire({
        role: 'implementer',
        config,
        writesFiles: 'direct',
      });
      mkdirSync(join(failed.projectDir, 'src'), { recursive: true });
      writeFileSync(join(failed.projectDir, 'src/dirty.ts'), firstAttempt);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/dirty.ts'), firstAttempt);
      failed.cleanup();

      const outcome = await runRetryStep({
        ctx: {
          projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner(),
          context: defaultContext,
          // The real direct-writer pipeline and the real change detector, not a
          // stub: what the retry concludes here is what a shipped runner gets.
          implementer: createImplementerBase({
            extractsCode: false,
            detectChanges: createChangeDetector('Tool implementer (test)'),
            invoke: async ({ projectDir: runDir }) => {
              writeFileSync(join(runDir, 'src/dirty.ts'), rewritten);
              return makeRunnerCallResult({ status: 'completed', text: 'rewrote src/dirty.ts' });
            },
          }),
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
          validator: createValidator(),
          isolation,
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
        invokeRetry: makeImplementerRetryInvoker({
          context: defaultContext,
          kind: 'local',
          languageContext: buildLanguageContext('typescript'),
          phase: state.phase,
          onOutput: () => {},
        }),
      });

      expect(outcome.lastError).not.toContain('exited without changing any files');
      expect(outcome.result).toMatchObject({ completed: true, method: 'local' });
      expect(readFileSync(join(projectDir, 'src/dirty.ts'), 'utf-8')).toBe(rewritten);
    } finally {
      await isolation.dispose();
    }
  });
});
