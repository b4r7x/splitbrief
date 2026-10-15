import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fileSystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import { isolationWorktreePath, isolationWorktreeRoot, sessionDir } from '../../../core/paths.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import type { Implementer, RetryOptions } from '../../implementers/types.js';
import { createImplementerBase } from '../../implementers/pipeline/run.js';
import { createChangeDetector } from '../../change-detection.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { createRunIsolation } from '../isolation/create.js';
import { runImplementation } from '../task/run-implementation.js';
import { createValidator } from '../validation/run.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { briefCorrections } from '../../../core/state/machine.js';
import { evidenceLedgerPath, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
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
  makeWctx,
  disposeWctxIsolations,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir as removeTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { transitionAndSave } from '../state-ops.js';
import { runRetryStep } from './step.js';
import type { RetryInvokeResult } from './types.js';

let dirs: string[] = [];
let stateHome = '';
const ORIGINAL_XDG_STATE_HOME = process.env.XDG_STATE_HOME;

function cleanupTempDir(dir: string): void {
  if (existsSync(join(dir, '.git'))) {
    rmSync(isolationWorktreeRoot(realpathSync(join(dir, '.git'))), {
      recursive: true,
      force: true,
    });
  }
  removeTempDir(dir);
}

beforeEach(() => {
  stateHome = createTempDir('retry-step-state-home');
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  try {
    await disposeWctxIsolations();
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
    removeTempDir(stateHome);
  } finally {
    if (ORIGINAL_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = ORIGINAL_XDG_STATE_HOME;
  }
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
      approval: { feedRejectionsToPlanner: true },
      workflow: {},
    }),
    implementerProfiles: {
      default: 'local-small',
      profiles: {
        'cheap-large': {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'deepseek-chat',
          contextLength: 128_000,
        },
        'local-small': {
          kind: 'api',
          provider: 'ollama',
          service: 'ollama',
          offering: 'local',
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen-small',
          contextLength: 8_192,
        },
      },
    },
  };
}

describe('runRetryStep', () => {
  it('refuses to move a validating brief into BUILD before its caller resumes it', async () => {
    const ref = setupProject();
    mkdirSync(join(ref.projectDir, 'src'), { recursive: true });
    writeFileSync(join(ref.projectDir, 'src/hello.ts'), 'export const hello = 1;\n');
    const task = makeTask({ status: 'in_progress' });
    const state = makeImplState([task], { phase: 'validating-task', attempt: 1 });
    saveState(ref, state);
    const ctx = {
      ...makeWctx({ ...ref, config: makeNoValidationConfig() }),
      taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      dependsOnFiles: [],
    };
    const invokeRetry = vi.fn(async () => ({ success: true, output: 'fixed' }));

    await expect(
      runRetryStep({
        ctx,
        task,
        state,
        lastError: 'apply the correction',
        attempts: 1,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'retry failed',
        invokeRetry,
      }),
    ).rejects.toThrow('Cannot apply UPDATE_TASK_CODE while workflow is in validating-task.');
    expect(loadState(ref)?.phase).toBe('validating-task');
    expect(invokeRetry).not.toHaveBeenCalled();
  });

  it('keeps a correction after validation passes when the implementer retry reports no usage', async () => {
    const ref = setupProject();
    const task = makeTask({
      checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
    });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const retry = vi.fn<Implementer['retry']>(async () => {
      const current = loadState(ref);
      if (current === null) throw new Error('missing state during retry');
      enqueueUserMessage({
        ...ref,
        state: current,
        message: plainUserMessage('keep the alias'),
        phase: current.phase,
        bus,
      });
      return { success: true, output: 'fixed' };
    });
    const implement = vi.fn<Implementer['implement']>(async () => ({
      success: true,
      output: 'alias kept',
    }));
    const ctx = {
      ...makeWctx({
        ...ref,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        implementer: makeImplementer({ retry, implement }),
        bus,
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      dependsOnFiles: [],
    };

    const outcome = await runRetryStep({
      ctx,
      task,
      state,
      lastError: 'failed check',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      invokeRetry: makeImplementerRetryInvoker({
        context: ctx.context,
        kind: 'local',
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: state.phase,
      }),
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(implement).toHaveBeenCalledTimes(1);
    expect(implement.mock.calls[0]?.[0].continuation?.steer).toContain('keep the alias');
    expect(outcome.result).toMatchObject({ completed: true, method: 'local', attempts: 1 });
    expect(briefCorrections(outcome.state, task.id)).toEqual([
      expect.stringContaining('keep the alias'),
    ]);
    const persisted = loadState(ref);
    if (persisted === null) throw new Error('missing state after validation');
    expect(persisted.tasks[0]?.status).toBe('done');
    expect(briefCorrections(persisted, task.id)).toEqual(briefCorrections(outcome.state, task.id));
    expect(persisted.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
  });

  it('writes one bundle receipt for a retry before completing the task', async () => {
    const ref = setupProject();
    const task = makeTask({ suggestedFiles: ['created.ts'] });
    const state = makeImplState([task]);
    const bytes = 'export const created = true;\n';
    const applyResult: BundleApplyResult = {
      status: 'applied',
      callId: 'retry-write',
      candidatePaths: ['created.ts'],
      applied: [
        {
          path: 'created.ts',
          action: 'create',
          beforeSha256: null,
          afterSha256: sha256Hex(bytes),
          diff: '',
          linesAdded: 1,
          linesRemoved: 0,
        },
      ],
      noops: [],
      untouched: [],
    };
    const ctx = {
      ...makeWctx({
        ...ref,
        implementer: makeImplementer({
          retry: async ({ projectDir }) => {
            writeFileSync(join(projectDir, 'created.ts'), bytes);
            return { success: true, output: 'created', applyResult };
          },
        }),
      }),
      taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
      dependsOnFiles: [],
    };
    const writes = vi.spyOn(fileSystem, 'renameSync');
    syncBuiltinESMExports();

    const outcome = await runRetryStep({
      ctx,
      task,
      state,
      lastError: 'failed check',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      invokeRetry: makeImplementerRetryInvoker({
        context: ctx.context,
        kind: 'local',
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: state.phase,
      }),
    });

    expect(outcome.result?.completed).toBe(true);
    expect(
      readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id)?.apiApply,
    ).toMatchObject({
      callId: 'retry-write',
      status: 'applied',
      applied: [expect.objectContaining({ path: 'created.ts', afterSha256: sha256Hex(bytes) })],
    });
    expect(
      writes.mock.calls.filter(([, target]) => target === evidenceLedgerPath(ref)),
    ).toHaveLength(1);
  });

  it.each([undefined, { inputTokens: 2, outputTokens: 1 }])(
    'preserves completed-call usage when an interrupted correction returns usage %j',
    async (usage) => {
      const ref = setupProject();
      const task = makeTask();
      const state = makeImplState([task]);
      const controller = new AbortController();
      const { bus, events } = makeBusRecorder();
      const retry = vi.fn<Implementer['retry']>(async () => {
        const current = loadState(ref);
        if (current === null) throw new Error('missing state during retry');
        enqueueUserMessage({
          ...ref,
          state: current,
          message: plainUserMessage('keep the alias'),
          phase: current.phase,
          bus,
        });
        return { success: true, output: 'fixed', usage: { inputTokens: 7, outputTokens: 3 } };
      });
      const implement = vi.fn<Implementer['implement']>(async () => {
        controller.abort();
        return { success: false, output: '', outcome: 'user-abort', usage };
      });
      const ctx = {
        ...makeWctx({
          ...ref,
          implementer: makeImplementer({ retry, implement }),
          signal: controller.signal,
          bus,
        }),
        taskStartSnapshot: await getChangedFilesSnapshot(ref.projectDir),
        dependsOnFiles: [],
      };

      const outcome = await runRetryStep({
        ctx,
        task,
        state,
        lastError: 'failed check',
        attempts: 1,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'retry failed',
        invokeRetry: makeImplementerRetryInvoker({
          context: ctx.context,
          kind: 'local',
          sessionId: ref.sessionId,
          languageContext: buildLanguageContext('typescript'),
          phase: state.phase,
        }),
      });

      expect(retry).toHaveBeenCalledTimes(1);
      expect(implement).toHaveBeenCalledTimes(1);
      expect(implement.mock.calls[0]?.[0].continuation?.steer).toContain('keep the alias');
      expect(outcome.result).toMatchObject({ completed: false, method: 'failed', attempts: 1 });
      const expected = {
        implementerInput: 7 + (usage?.inputTokens ?? 0),
        implementerOutput: 3 + (usage?.outputTokens ?? 0),
      };
      expect(outcome.state.tokenUsage).toMatchObject(expected);
      expect(loadState(ref)?.tokenUsage).toMatchObject(expected);
      const counted = transitionAndSave(ctx, outcome.state, {
        type: 'COUNT_ATTEMPT',
        taskId: task.id,
      });
      expect(counted.tokenUsage).toMatchObject(expected);
      expect(loadState(ref)?.tokenUsage).toMatchObject(expected);
      expect(events.filter((event) => event.type === 'task_completed')).toEqual([]);
    },
  );

  it.each(['partial', 'failed'] as const)(
    'puts back a checkout retry with a %s API write and saves the replaced bytes',
    async (status) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({
        id: 'T041',
        action: 'create',
        suggestedFiles: ['created.ts', 'uncertain.ts'],
      });
      const config = makeNoValidationConfig({ workflow: { isolation: 'none' } });
      const isolation = createRunIsolation({
        projectDir,
        sessionId,
        strategy: 'none',
        onFallback: () => {},
      });
      const opened = await isolation.open({ config });
      const state = makeImplState([task], {
        workspace: {
          kind: 'checkout',
          path: projectDir,
          base: { snapshotId: 'base', head: opened.head },
        },
      });
      const bytes = 'export const created = true;\n';
      const unknown = 'export const uncertain = true;\n';
      const ctx = {
        ...makeWctx({ projectDir, sessionId, config, isolation }),
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        dependsOnFiles: [],
      };
      try {
        const outcome = await runRetryStep({
          ctx,
          task,
          state,
          lastError: 'failed check',
          attempts: 1,
          method: 'local',
          transitionType: 'VALIDATION_PASS',
          usageCategory: 'implementer',
          retryFailureFallback: 'retry failed',
          invokeRetry: async ({ projectDir: dir }) => {
            writeFileSync(join(dir, task.suggestedFiles[0]), bytes);
            writeFileSync(join(dir, 'uncertain.ts'), unknown);
            const common = {
              callId: 'retry-write',
              candidatePaths: [task.suggestedFiles[0], 'uncertain.ts'],
              error: 'write failed',
              failedPath: 'uncertain.ts',
              noops: [],
              untouched: [],
            };
            const applyResult: Extract<BundleApplyResult, { status: 'partial' | 'failed' }> =
              status === 'partial'
                ? {
                    ...common,
                    status: 'partial',
                    code: 'io-failure',
                    applied: [
                      {
                        path: task.suggestedFiles[0],
                        action: 'create',
                        beforeSha256: null,
                        afterSha256: sha256Hex(bytes),
                        diff: '',
                        linesAdded: 1,
                        linesRemoved: 0,
                      },
                    ],
                  }
                : { ...common, status: 'failed', code: 'write-uncertain', applied: [] };
            return { success: false, error: applyResult.error, applyResult };
          },
        });
        expect(existsSync(join(projectDir, task.suggestedFiles[0]))).toBe(false);
        expect(existsSync(join(projectDir, 'uncertain.ts'))).toBe(false);
        const reverted = join(sessionDir(projectDir, sessionId), 'reverted');
        const stamp = readdirSync(reverted)[0];
        if (stamp === undefined) throw new Error('missing retry backup');
        expect(readFileSync(join(reverted, stamp, task.suggestedFiles[0]), 'utf8')).toBe(bytes);
        expect(readFileSync(join(reverted, stamp, 'uncertain.ts'), 'utf8')).toBe(unknown);
        expect(outcome.state.pendingRecovery?.details?.join('\n')).toContain(
          '.splitbrief/sessions/sess-retry-step/reverted',
        );
        expect(outcome.state.pendingRecovery?.details?.join('\n')).not.toContain(
          'the checkout is unchanged',
        );
        expect(recordedApiCreatedPaths(ctx, task, projectDir)).toEqual([]);
      } finally {
        await isolation.dispose();
      }
    },
  );
  it('a retry of an extracted-code writer acquires the same workspace as the first attempt', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ suggestedFiles: ['src/value.ts'], action: 'modify' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const original = 'export const value = 1;\n';
    writeFileSync(join(projectDir, task.suggestedFiles[0]), original);
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const receivedDirs: string[] = [];
    const wctx = makeWctx({
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      implementer: makeImplementer({
        capabilities: { writesFiles: 'extracted-code' },
        implement: async ({ projectDir: dir }) => {
          receivedDirs.push(dir);
          writeFileSync(join(dir, task.suggestedFiles[0]), 'export const value = "failed";\n');
          return { success: false, output: '', error: 'failed first attempt' };
        },
      }),
    });

    try {
      const first = await runImplementation({
        wctx,
        task,
        state: makeImplState([task]),
        taskStartSnapshot,
        setTrackedState: vi.fn(),
        recordApprovalDenial: vi.fn(),
      });
      first.workspace?.cleanup();
      await runRetryStep({
        ctx: { ...wctx, taskStartSnapshot, dependsOnFiles: [] },
        task,
        state: first.state,
        lastError: 'failed first attempt',
        attempts: 1,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'retry failed',
        invokeRetry: async ({ projectDir: dir }) => {
          receivedDirs.push(dir);
          writeFileSync(join(dir, task.suggestedFiles[0]), 'export const value = "retry";\n');
          return { success: false, output: '', error: 'retry failed' };
        },
      });

      expect(first.workspace).toBeDefined();
      expect(receivedDirs).toEqual([first.workspace?.projectDir, first.workspace?.projectDir]);
      expect(receivedDirs[0]).not.toBe(projectDir);
      expect(readFileSync(join(projectDir, task.suggestedFiles[0]), 'utf8')).toBe(original);
    } finally {
      await wctx.isolation.dispose();
    }
  });

  it('passes the workflow abort signal to retry invocation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T000', suggestedFiles: ['src/signal.ts'] });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const controller = new AbortController();
    let retrySignal: AbortSignal | undefined;
    const invokeRetry = vi.fn().mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      retrySignal = signal;
      return { success: false, error: 'still failing' };
    });

    await runRetryStep({
      ctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
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

    // The invocation gets the workflow signal composed with the per-call one.
    expect(retrySignal?.aborted).toBe(false);
    controller.abort();
    expect(retrySignal?.aborted).toBe(true);
  });

  it('records the usage of a transient attempt a retry replaced', async () => {
    vi.useFakeTimers();
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T007', suggestedFiles: ['src/transient.ts'] });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    let calls = 0;
    const implementer = makeImplementer({
      retry: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? {
              success: false,
              output: 'busy',
              error: 'HTTP 503 Service Unavailable',
              outcome: 'non-zero-exit' as const,
              usage: { inputTokens: 7, outputTokens: 3 },
            }
          : { success: true, output: 'fixed', usage: { inputTokens: 2, outputTokens: 1 } };
      }),
    });

    const pending = runRetryStep({
      ctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
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
      invokeRetry: makeImplementerRetryInvoker({
        context: defaultContext,
        kind: 'local',
        sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: state.phase,
        implementer,
        config,
      }),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 2_000);
    }
    const outcome = await pending;

    expect(outcome.result).toMatchObject({ completed: true, method: 'local' });
    // The replaced attempt's tokens persist beside the surviving attempt's own.
    const saved = loadState({ projectDir, sessionId });
    expect(saved?.tokenUsage.implementerInput).toBe(9);
    expect(saved?.tokenUsage.implementerOutput).toBe(4);
  });

  it('intermediate-tier usage-limit failure records the intermediate runner in lastFailure.runner', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T006', suggestedFiles: ['src/intermediate-fail.ts'] });
    const state = makeImplState([task]);
    const defaultImplementer = {
      kind: 'api' as const,
      provider: 'ollama' as const,
      service: 'ollama' as const,
      offering: 'local' as const,
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen-small',
    };
    const intermediateRunner = {
      kind: 'api' as const,
      provider: 'custom-endpoint' as const,
      service: 'custom-endpoint' as const,
      offering: 'payg' as const,
      apiBase: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'x-ai/grok-4-fast',
    };
    const config = makeNoValidationConfig({ implementer: defaultImplementer });
    const intermediateConfig = { ...config, implementer: intermediateRunner };
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const intermediateImplementer = makeImplementer({
      retry: async () => ({
        success: false,
        output: '',
        error: 'rate limit exceeded',
        outcome: 'usage-limit',
      }),
    });

    const outcome = await runRetryStep({
      ctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
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
      method: 'escalated-intermediate',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'Intermediate escalation failed',
      invokeRetry: makeImplementerRetryInvoker({
        context: defaultContext,
        kind: 'local',
        sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: state.phase,
        implementer: intermediateImplementer,
        config: intermediateConfig,
      }),
    });

    expect(outcome.lastFailure).toEqual({
      outcome: 'usage-limit',
      runner: intermediateRunner,
    });
  });

  it('uses an overridden implementer profile for retry execution and completion metadata', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/profile.ts'] });
    const state = makeImplState([task]);
    const config = configWithProfiles();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const defaultRetry = async () => {
      throw new Error('default implementer should not handle an overridden retry');
    };
    let receivedRetry: RetryOptions | undefined;
    const overrideRetry = async (opts: RetryOptions) => {
      receivedRetry = opts;
      return {
        success: true,
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
        workspaceDir: projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
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

    expect(receivedRetry).toMatchObject({
      error: 'validation failed',
      attempt: 1,
      kind: 'local',
      config: { implementer: { kind: 'api', provider: 'custom-endpoint', model: 'deepseek-chat' } },
    });
    expect(outcome.result).toEqual({
      completed: true,
      method: 'local',
      attempts: 1,
      durationMs: expect.any(Number),
    });
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      type: 'task_completed',
      taskId: 'T001',
      method: 'local',
      implementerProfile: 'cheap-large',
      tool: 'custom-endpoint',
      model: 'deepseek-chat',
    });
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      implementerTool: 'custom-endpoint',
      implementerModel: 'deepseek-chat',
    });
  });

  it('propagates the profile-resolution error instead of retrying', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T002', suggestedFiles: ['src/missing.ts'] });
    const invokeRetry = vi.fn();

    await expect(
      runRetryStep({
        ctx: {
          ...makeWctx({ projectDir, sessionId, config: configWithProfiles() }),
          taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
          dependsOnFiles: [],
        },
        task,
        state: makeImplState([task]),
        lastError: 'validation failed',
        attempts: 1,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'retry failed',
        profileOverride: 'nonexistent-profile',
        invokeRetry,
      }),
    ).rejects.toThrow(/nonexistent-profile/);
    expect(invokeRetry).not.toHaveBeenCalled();
  });

  it('uses the default implementer when profileOverride is undefined', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T003', suggestedFiles: ['src/default.ts'] });
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
        workspaceDir: projectDir,
        sessionId,
        config,
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
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
      durationMs: expect.any(Number),
    });
  });

  it('retries in the run worktree the failed attempt used, keeping only its promoted work', {
    timeout: 60_000,
  }, async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T004', suggestedFiles: ['src/shared.ts'] });
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
    });
    const promoted = 'export const shared = true;\n';

    try {
      const failed = await isolation.acquire({
        role: 'implementer',
        config,
      });
      expect(failed.projectDir).toBe(
        isolationWorktreePath(realpathSync(join(projectDir, '.git')), sessionId),
      );

      // What the failed attempt promoted before validation rejected it, and the
      // half-written file the same attempt left behind unpromoted.
      mkdirSync(join(failed.projectDir, 'src'), { recursive: true });
      writeFileSync(join(failed.projectDir, 'src/shared.ts'), promoted);
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src/shared.ts'), promoted);
      writeFileSync(join(failed.projectDir, 'src/abandoned.ts'), 'export const half = 1;\n');
      failed.cleanup(['src/abandoned.ts']);

      const retryDirs: string[] = [];
      const outcome = await runRetryStep({
        ctx: {
          projectDir,
          workspaceDir: projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner(),
          reviewer: makePlanner(),
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
    const task = makeTask({ id: 'T005', suggestedFiles: ['src/dirty.ts'] });
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
    });
    const firstAttempt = 'export const dirty = "written by the attempt that failed";\n';
    const rewritten = 'export const dirty = "rewritten by the retry";\n';

    try {
      // The failed attempt wrote the file, so the run worktree is already dirty
      // in the very path the retry rewrites. A detector that compares path
      // membership sees nothing new there.
      const failed = await isolation.acquire({
        role: 'implementer',
        config,
      });
      mkdirSync(join(failed.projectDir, 'src'), { recursive: true });
      writeFileSync(join(failed.projectDir, 'src/dirty.ts'), firstAttempt);

      const outcome = await runRetryStep({
        ctx: {
          projectDir,
          workspaceDir: failed.projectDir,
          sessionId,
          config,
          callbacks,
          bus,
          planner: makePlanner(),
          reviewer: makePlanner(),
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
          sessionId,
          languageContext: buildLanguageContext('typescript'),
          phase: state.phase,
        }),
      });

      expect(outcome.lastError).not.toContain('exited without changing any files');
      expect(outcome.result).toMatchObject({ completed: true, method: 'local' });
      expect(readFileSync(join(failed.projectDir, 'src/dirty.ts'), 'utf-8')).toBe(rewritten);
      expect(existsSync(join(projectDir, 'src/dirty.ts'))).toBe(false);
    } finally {
      await isolation.dispose();
    }
  });
});

describe('runRetryStep — a failed attempt keeps its story', () => {
  async function runFailingRetry(
    retryResult: Partial<RetryInvokeResult>,
  ): Promise<Awaited<ReturnType<typeof runRetryStep>>> {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T040', suggestedFiles: ['src/story.ts'] });
    return runRetryStep({
      ctx: {
        ...makeWctx({ projectDir, sessionId, config: makeNoValidationConfig() }),
        taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
        dependsOnFiles: [],
      },
      task,
      state: makeImplState([task]),
      lastError: 'tsc: Type X is not assignable to Y',
      attempts: 1,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'retry failed',
      invokeRetry: async () => ({ ...retryResult, success: false }),
    });
  }

  it('names its own cause, never the incoming error, and carries the hand-back when the attempt changed nothing', async () => {
    const outcome = await runFailingRetry({
      outcome: 'no-staged-change',
      error: 'agy exited without changing any files',
      output: 'I could not find the prop.',
    });

    expect(outcome.lastError).toBe('agy exited without changing any files');
    expect(outcome.lastFailure).toMatchObject({
      outcome: 'no-staged-change',
      handBack: 'I could not find the prop.',
    });
    expect(outcome.result).toBeUndefined();
  });

  it('takes the attempt error for every other outcome', async () => {
    const outcome = await runFailingRetry({ outcome: 'timeout', error: 'Runner timed out' });

    expect(outcome.lastError).toBe('Runner timed out');
    expect(outcome.lastFailure?.outcome).toBe('timeout');
  });

  it('carries no hand-back for whitespace output', async () => {
    const outcome = await runFailingRetry({ outcome: 'no-staged-change', output: '   ' });

    expect(outcome.lastFailure).toBeDefined();
    expect(outcome.lastFailure !== undefined && 'handBack' in outcome.lastFailure).toBe(false);
  });

  it('bounds the hand-back to the last 2000 characters', async () => {
    const output = `${'x'.repeat(4000)}${'y'.repeat(1000)}`;
    const outcome = await runFailingRetry({ outcome: 'no-staged-change', output });

    expect(outcome.lastFailure?.handBack?.length).toBe(2000);
    expect(outcome.lastFailure?.handBack).toBe(output.slice(-2000));
  });
});

describe('runRetryStep — gate denial', () => {
  it('attempt-denied package change is restored before returning a failed retry without recovery', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T030', suggestedFiles: ['src/main.ts'] });
    const state = makeImplState([task]);
    const { callbacks } = makeCallbacks({
      onTieredApproval: vi
        .fn()
        .mockResolvedValue({ decision: 'deny', reason: 'package change denied' }),
    });
    const { bus, events } = makeBusRecorder();
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    const retryWorkspaceDirs: string[] = [];
    // The brief gate formats the changed files first: an attempt that never reaches the gate formats nothing.
    const formatChangedFiles = vi.fn().mockResolvedValue(undefined);

    const outcome = await runRetryStep({
      ctx: {
        projectDir,
        workspaceDir: projectDir,
        sessionId,
        config: makeNoValidationConfig({
          approval: { feedRejectionsToPlanner: false },
          workflow: {},
        }),
        callbacks,
        bus,
        planner: makePlanner(),
        reviewer: makePlanner(),
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        validator: { formatChangedFiles },
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
      invokeRetry: async ({ projectDir: runDir }) => {
        retryWorkspaceDirs.push(runDir);
        writeFileSync(join(runDir, 'package.json'), '{"name":"changed"}\n');
        return { success: true };
      },
    });

    expect(outcome.result).toEqual({
      completed: false,
      method: 'failed',
      attempts: 1,
      lastError:
        "Retry changed files blocked by approval gate: package change denied. SPLITBRIEF discarded this attempt's writes to package.json. Retry from the current files; do not try to recover the rejected writes.",
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(formatChangedFiles).not.toHaveBeenCalled();
    expect(retryWorkspaceDirs.map((dir) => existsSync(join(dir, 'package.json')))).toEqual([false]);
    expect(existsSync(join(projectDir, 'package.json'))).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.type === 'error' &&
          event.message ===
            "Retry changed files blocked by approval gate: package change denied. SPLITBRIEF discarded this attempt's writes to package.json.",
      ),
    ).toHaveLength(1);
  });
});
