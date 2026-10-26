import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { briefCorrections } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { createEventBus } from '../../events/bus.js';
import { createSteeringPort, type SteerOutcome } from '../../calls/steering.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import { createQueueHandler, enqueueUserMessage } from '../queue/submit.js';
import { createWriteSequencer } from '../serial-executor.js';
import {
  recordApiApplyEvidence,
  recordApiRevertEvidence,
  recordedApiCreatedPaths,
} from '../evidence/task.js';
import { withContinuationLoop } from '../continuation.js';
import { addUsageAndSave } from '../state-ops.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

function makeRecordingImplementer() {
  let received: RetryOptions | undefined;
  const implementer = makeImplementer({
    retry: async (opts: RetryOptions) => {
      received = opts;
      return { success: true, output: 'fixed', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  return { implementer, getReceived: () => received };
}

describe('makeImplementerRetryInvoker', () => {
  it.each([
    ['local', true],
    ['consult', true],
    ['local', false],
    ['consult', false],
  ] as const)(
    'allows unchanged output for a %s attempt only when it delivers an answer (%s)',
    async (kind, deliversAnswer) => {
      const ref = setupProject(directories);
      const task = makeTask();
      const { implementer, getReceived } = makeRecordingImplementer();
      const invoker = makeImplementerRetryInvoker({
        context: defaultContext,
        kind,
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: 'implementing',
      });

      const result = await invoker({
        task,
        lastError: 'Keep the default export.',
        attempts: 0,
        deliversAnswer,
        projectDir: ref.projectDir,
        implementer,
        config: makeConfig(),
        seat: {
          ref: { ...ref, bus: createEventBus() },
          state: makeImplState([task]),
          usageCategory: 'implementer',
        },
      });

      expect(result.success).toBe(true);
      expect(getReceived()).toMatchObject({ kind, allowNoChange: deliversAnswer });
    },
  );

  it.each(['local', 'consult'] as const)(
    'classifies %s output using the selected implementer, including profile overrides',
    async (kind) => {
      for (const writesFiles of ['direct', 'extracted-code'] as const) {
        for (const override of [false, true]) {
          const ref = setupProject(directories);
          const { bus, events } = makeBusRecorder();
          const selected = makeImplementer({
            capabilities: { writesFiles },
            retry: async ({ onOutput }) => {
              onOutput('# Load config', { messageStart: true });
              return { success: true, output: 'fixed' };
            },
          });
          const invoker = makeImplementerRetryInvoker({
            context: defaultContext,
            kind,
            sessionId: ref.sessionId,
            languageContext: buildLanguageContext('python'),
            phase: 'implementing',
            ...(override ? { implementer: selected } : {}),
          });

          await invoker({
            task: makeTask(),
            lastError: 'validation failed',
            attempts: 1,
            projectDir: ref.projectDir,
            config: makeConfig(),
            implementer: override ? makeImplementer() : selected,
            fileIgnoreProjectDir: '/project',
            seat: {
              ref: { ...ref, bus },
              state: makeImplState([makeTask()]),
              usageCategory: 'implementer',
            },
          });

          expect(events.filter((event) => event.type === 'planner_text')).toEqual([
            {
              type: 'planner_text',
              ts: expect.any(Number),
              phase: 'implementing',
              role: 'implementer',
              content: writesFiles === 'direct' ? 'markdown' : 'plain',
              text: '# Load config',
              ...(writesFiles === 'direct' ? { messageStart: true } : {}),
            },
          ]);
        }
      }
    },
  );

  it.each([{ createdByThisTask: undefined }, { createdByThisTask: ['src/reverted.ts'] }])(
    'uses current creation proof only when ownership was supplied as $createdByThisTask',
    async ({ createdByThisTask }) => {
      const ref = setupProject(directories);
      const task = makeTask({
        action: 'create',
        suggestedFiles: ['src/reverted.ts', 'src/kept.ts'],
      });
      const state = makeImplState([task]);
      saveState(ref, state);
      const ledger = recordApiApplyEvidence({
        ledger: createEvidenceLedger({ ...ref, feature: 'feat', tasks: [task] }),
        task,
        workspacePath: ref.projectDir,
        result: {
          callId: 'create-files',
          status: 'applied',
          candidatePaths: task.suggestedFiles,
          applied: task.suggestedFiles.map((path) => ({
            path,
            action: 'create',
            beforeSha256: null,
            afterSha256: 'a1',
            diff: '',
            linesAdded: 1,
            linesRemoved: 0,
          })),
          noops: [],
          untouched: [],
        },
      });
      writeEvidenceLedger(
        ref,
        recordApiRevertEvidence({
          ledger,
          workspacePath: ref.projectDir,
          removedPaths: ['src/reverted.ts'],
        }),
      );
      const { implementer, getReceived } = makeRecordingImplementer();
      const invoker = makeImplementerRetryInvoker({
        context: defaultContext,
        kind: 'local',
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: state.phase,
      });

      await invoker({
        task,
        lastError: 'check failed',
        attempts: 1,
        projectDir: ref.projectDir,
        implementer,
        config: makeConfig(),
        createdByThisTask,
        seat: { ref: { ...ref, bus: createEventBus() }, state, usageCategory: 'implementer' },
      });

      expect(getReceived()?.createdByThisTask).toEqual(
        createdByThisTask === undefined ? undefined : ['src/kept.ts'],
      );
    },
  );

  it('waits out a near reset holding the BUILD profile the retry runs on', async () => {
    const ref = setupProject(directories);
    const task = makeTask();
    const state = makeImplState([task]);
    saveState(ref, state);
    const claudeCode = { kind: 'cli', tool: 'claude-code' } as const;
    const config = makeConfig({
      implementer: claudeCode,
      implementerProfiles: {
        default: 'small',
        profiles: { big: claudeCode, small: { kind: 'cli', tool: 'codex' } },
      },
    });
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: '',
        error: "You've hit your usage limit. Try again in 5 minutes.",
      })
      .mockResolvedValueOnce({ success: true, output: 'fixed' });
    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
    });

    vi.useFakeTimers();
    const pending = invoker({
      task,
      lastError: 'check failed',
      attempts: 1,
      projectDir: ref.projectDir,
      implementer: makeImplementer({ retry }),
      config,
      seat: {
        ref: { ...ref, bus: createEventBus(), implementerProfile: 'big' },
        state,
        usageCategory: 'implementer',
      },
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
    let wait: WorkflowState['seatWait'];
    try {
      while (!settled) {
        wait ??= loadState(ref)?.seatWait;
        await vi.advanceTimersByTimeAsync(vi.getTimerCount() === 0 ? 1 : 30_000);
      }
    } finally {
      vi.useRealTimers();
    }
    await pending;

    expect(retry).toHaveBeenCalledTimes(2);
    expect(wait?.holds).toEqual({ tool: 'claude-code', kind: 'cli', profile: 'big' });
  });

  it('passes one steering port to the retry and its correction pass', async () => {
    const ref = setupProject(directories);
    const task = makeTask();
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const steering = createSteeringPort();
    const delivery = Promise.withResolvers<SteerOutcome>();
    const detach = steering.attach({
      callId: 'prior-build',
      role: 'implementer',
      taskId: task.id,
      send: () => delivery.promise,
    });
    const handler = createQueueHandler({
      config: makeConfig(),
      ...ref,
      steering,
      bus,
      planner: makePlanner(),
      serialize: createWriteSequencer(),
      getState: () => state,
      setState: () => {},
    });
    await handler(plainUserMessage('keep this correction on retries'), state.phase);
    detach();
    const calls: ImplementerOptions[] = [];
    const implementer = makeImplementer({
      retry: async (call) => {
        calls.push(call);
        enqueueUserMessage({
          ...ref,
          state,
          bus,
          message: plainUserMessage('keep the API'),
          phase: state.phase,
        });
        return { success: true, output: '' };
      },
      implement: async (call) => {
        calls.push(call);
        return { success: true, output: '' };
      },
    });
    const invoke = makeImplementerRetryInvoker({
      steering,
      context: defaultContext,
      kind: 'local',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: state.phase,
    });
    const running = invoke({
      task,
      lastError: 'checks failed',
      attempts: 1,
      projectDir: ref.projectDir,
      config: makeConfig(),
      implementer,
      seat: { ref: { ...ref, bus }, state, usageCategory: 'implementer' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callsBeforeDelivery = calls.length;
    delivery.resolve('delivered');
    const result = await running;

    expect(callsBeforeDelivery).toBe(0);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.steering).toBe(steering);
    expect(calls[0]?.continuation?.steer).toContain('keep this correction on retries');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'queue_drained', via: 'mid-call' }),
    );
    expect(calls[1]?.continuation?.steer).toContain('keep the API');
  });

  it.each(['throw', 'return'] as const)(
    'counts retry usage once after an interrupted correction exits by %s and continues',
    async (exit) => {
      const ref = setupProject(directories);
      const task = makeTask();
      const state = makeImplState([task]);
      saveState(ref, state);
      const { bus } = makeBusRecorder();
      let abort: (() => void) | null = null;
      let retries = 0;
      const implementer = makeImplementer({
        retry: async () => {
          retries += 1;
          if (retries === 1) {
            enqueueUserMessage({
              ...ref,
              state,
              bus,
              phase: 'implementing',
              message: plainUserMessage('correct the retry'),
            });
          }
          return {
            success: true,
            output: 'retried',
            usage:
              retries === 1
                ? { inputTokens: 10, outputTokens: 4 }
                : { inputTokens: 3, outputTokens: 2 },
          };
        },
        implement: async () => {
          abort?.();
          if (exit === 'throw') throw new DOMException('Stopped', 'AbortError');
          return { success: false, output: '', usage: { inputTokens: 2, outputTokens: 1 } };
        },
      });
      const invoker = makeImplementerRetryInvoker({
        context: defaultContext,
        kind: 'local',
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: 'implementing',
      });
      const continued = await withContinuationLoop({
        ctx: {
          ...ref,
          bus,
          callbacks: makeCallbacks({
            onContinuationNeeded: async () => {
              expect(loadState(ref)?.tokenUsage.implementerInput).toBe(10);
              return plainUserMessage('continue this retry');
            },
          }).callbacks,
          sinks: {
            setAbortHandler: (handler) => {
              abort = handler;
            },
            setQueueHandler: () => {},
          },
        },
        state,
        step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
        body: ({ signal }) =>
          invoker({
            task,
            lastError: 'validation failed',
            attempts: state.attempt,
            projectDir: ref.projectDir,
            implementer,
            config: makeConfig(),
            signal,
            seat: {
              ref: { ...ref, bus },
              state: loadState(ref) ?? state,
              usageCategory: 'implementer',
            },
          }),
      });

      expect(retries).toBe(2);
      expect(continued.value.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
      const accounted = addUsageAndSave(
        { ...ref, bus },
        continued.state,
        'implementer',
        continued.value.usage,
      );
      expect(accounted.tokenUsage).toMatchObject({
        implementerInput: 13,
        implementerOutput: 6,
      });
      expect(loadState(ref)?.tokenUsage).toEqual(accounted.tokenUsage);
    },
  );

  it('records the retry application before a correction transport failure', async () => {
    const ref = setupProject(directories);
    const task = makeTask({ action: 'create', suggestedFiles: ['src/owned.ts'] });
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const implement = vi.fn(async (call: ImplementerOptions) => {
      expect(call.createdByThisTask).toEqual(['src/owned.ts']);
      expect(recordedApiCreatedPaths(ref, task, ref.projectDir)).toEqual(['src/owned.ts']);
      return { success: false, output: '', error: 'connection lost' };
    });
    const implementer = makeImplementer({
      implement,
      retry: async () => {
        enqueueUserMessage({
          ...ref,
          state,
          bus,
          phase: 'implementing',
          message: plainUserMessage('keep the creation'),
        });
        return {
          success: true,
          output: 'created',
          applyResult: {
            callId: 'retry-create',
            status: 'applied',
            candidatePaths: ['src/owned.ts'],
            applied: [
              {
                path: 'src/owned.ts',
                action: 'create',
                beforeSha256: null,
                afterSha256: 'a1',
                diff: '',
                linesAdded: 1,
                linesRemoved: 0,
              },
            ],
            noops: [],
            untouched: [],
          },
        };
      },
    });
    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
    });

    const result = await invoker({
      task,
      lastError: 'check failed',
      attempts: 1,
      projectDir: ref.projectDir,
      implementer,
      config: makeConfig(),
      createdByThisTask: [],
      seat: { ref: { ...ref, bus }, state, usageCategory: 'implementer' },
    });

    expect(result.success).toBe(false);
    expect(result.applyResult).toBeUndefined();
    expect(implement).toHaveBeenCalledTimes(1);
    expect(
      readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id)?.apiApply?.callId,
    ).toBe('retry-create');
  });

  it('forwards invoke args and fixed options into the invoke-arg implementer', async () => {
    const ref = setupProject(directories);
    const { implementer, getReceived } = makeRecordingImplementer();
    const languageContext = buildLanguageContext('typescript');
    const config = makeConfig();
    const task = makeTask({
      fix: { cycle: 1, findings: [{ id: 'F1', text: 'Keep the error', acceptance: null }] },
    });
    const signal = new AbortController().signal;
    const plan = {
      summary: 'Route every write through the registry.',
      decisions: [{ text: 'Keep the registry as the one source of truth', taskId: null }],
      criteria: [],
      checks: [],
      validation: null,
    };

    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'consult',
      sessionId: ref.sessionId,
      languageContext,
      phase: 'implementing',
    });

    const result = await invoker({
      task,
      lastError: 'boom',
      attempts: 3,
      projectDir: '/staged',
      config,
      implementer,
      signal,
      sandboxEnv: { FOO: 'bar' },
      fileIgnoreProjectDir: '/project',
      changeDetection: 'file-hashes',
      createdByThisTask: ['src/owned.ts'],
      seat: {
        ref: { ...ref, bus: createEventBus() },
        state: { ...makeImplState([task]), plan },
        usageCategory: 'implementer',
      },
    });

    expect(result).toEqual({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 1, outputTokens: 1 },
      runner: config.implementer,
    });

    const received = getReceived();
    expect(received).toMatchObject({
      task,
      projectDir: '/staged',
      config,
      context: defaultContext,
      languageContext,
      error: 'boom',
      attempt: 3,
      kind: 'consult',
      sessionId: ref.sessionId,
      phase: 'implementing',
      signal,
      sandboxEnv: { FOO: 'bar' },
      fileIgnoreProjectDir: '/project',
      changeDetection: 'file-hashes',
      createdByThisTask: [],
      plan,
      allowNoChange: true,
    });
  });

  it('routes to the override implementer and config when provided', async () => {
    const ref = setupProject(directories);
    const argImpl = makeRecordingImplementer();
    const override = makeRecordingImplementer();
    const overrideConfig = makeConfig({ implementer: { model: 'override-model' } });

    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
      implementer: override.implementer,
      config: overrideConfig,
    });

    const result = await invoker({
      task: makeTask(),
      lastError: 'boom',
      attempts: 1,
      projectDir: '/staged',
      config: makeConfig({ implementer: { model: 'arg-model' } }),
      implementer: argImpl.implementer,
      fileIgnoreProjectDir: '/project',
      seat: {
        ref: { ...ref, bus: createEventBus() },
        state: makeImplState([makeTask()]),
        usageCategory: 'implementer',
      },
    });

    expect(result.runner).toEqual(overrideConfig.implementer);
    expect(argImpl.getReceived()).toBeUndefined();
    expect(override.getReceived()?.config.implementer.model).toBe('override-model');
    expect(override.getReceived()?.kind).toBe('local');
    expect(override.getReceived()?.allowNoChange).toBe(false);
  });

  it.each([true, false])(
    'uses the effective retry seat image fact (vision=%s) for its correction pass',
    async (vision) => {
      const ref = setupProject(directories);
      const task = makeTask();
      const state = makeImplState([task], { attempt: 2 });
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const implement = vi.fn(async (_call: ImplementerOptions) => ({
        success: true,
        output: 'corrected',
        usage: { inputTokens: 7, outputTokens: 5 },
      }));
      const retry = vi.fn(async (_call: RetryOptions) => {
        const message = {
          ...plainUserMessage('keep the parser shared'),
          images: [
            {
              id: 'retry-reference',
              kind: 'image' as const,
              path: '/retry-reference.png',
              mimeType: 'image/png',
              sizeBytes: 12,
            },
          ],
        };
        enqueueUserMessage({
          ...ref,
          state,
          bus,
          phase: 'implementing',
          message,
        });
        return { success: true, output: 'retried', usage: { inputTokens: 10, outputTokens: 4 } };
      });
      const implementer = makeImplementer({ implement, retry });
      const config = makeConfig({
        implementer: { kind: 'api', provider: 'lm-studio', model: 'fixture' },
      });
      const invoker = makeImplementerRetryInvoker({
        context: defaultContext,
        kind: 'local',
        sessionId: ref.sessionId,
        languageContext: buildLanguageContext('typescript'),
        phase: 'implementing',
        config,
      });

      const result = await invoker({
        task,
        lastError: 'validation failed',
        attempts: 2,
        projectDir: ref.projectDir,
        implementer,
        config: makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'fixture' } }),
        createdByThisTask: ['src/owned.ts'],
        seat: {
          ref: {
            ...ref,
            bus,
            modelCache: {
              getModelsDevCatalog: () => null,
              getProviderModels: () => [{ id: 'fixture', supportsImages: vision }],
            },
          },
          state,
          usageCategory: 'implementer',
        },
      });

      expect(retry).toHaveBeenCalledTimes(1);
      expect(implement).toHaveBeenCalledTimes(1);
      const pass = implement.mock.calls[0]?.[0];
      expect(pass?.continuation?.steer).toContain('keep the parser shared');
      expect(pass?.images).toEqual(
        vision
          ? [expect.objectContaining({ id: 'retry-reference', path: '/retry-reference.png' })]
          : undefined,
      );
      expect(pass?.continuation?.steer).toContain('[image:retry-reference] = /retry-reference.png');
      expect(events.filter((event) => event.type === 'build_images_as_paths')).toEqual(
        vision ? [] : [expect.objectContaining({ taskId: 'T001', count: 1 })],
      );
      expect(pass).toMatchObject({
        task,
        onOutput: retry.mock.calls[0]?.[0].onOutput,
        allowNoChange: true,
        createdByThisTask: [],
      });
      expect(pass?.continuation?.partial).toBeUndefined();
      expect(result).toMatchObject({
        success: true,
        output: 'corrected',
        usage: { inputTokens: 17, outputTokens: 9 },
        runner: config.implementer,
      });
      const saved = loadState(ref);
      expect(saved?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
      expect(saved?.attempt).toBe(2);
      expect(saved && briefCorrections(saved, task.id)).toEqual([
        expect.stringContaining('keep the parser shared'),
      ]);
      expect(events.filter((event) => event.type === 'queue_drained')).toEqual([
        expect.objectContaining({ seat: 'build', taskId: task.id, count: 1 }),
      ]);
    },
  );

  it('puts pending messages into the retry steer before the retry call', async () => {
    const ref = setupProject(directories);
    const task = makeTask();
    const initial = makeImplState([task]);
    saveState(ref, initial);
    const { bus } = makeBusRecorder();
    enqueueUserMessage({
      ...ref,
      state: initial,
      bus,
      phase: 'implementing',
      message: plainUserMessage('preserve the public signature'),
    });
    const { implementer, getReceived } = makeRecordingImplementer();
    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'consult',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
    });

    await invoker({
      task,
      lastError: 'check failed',
      attempts: 3,
      projectDir: '/staged',
      implementer,
      config: makeConfig(),
      seat: { ref: { ...ref, bus }, state: initial, usageCategory: 'implementer' },
    });

    expect(getReceived()?.continuation?.steer).toContain('preserve the public signature');
    expect(getReceived()?.allowNoChange).toBe(false);
    expect(implementer.implement).not.toHaveBeenCalled();
    const saved = loadState(ref);
    expect(saved?.messageQueue[0]?.deliveredTo?.implementer).toBeDefined();
    expect(saved && briefCorrections(saved, task.id)).toEqual([
      expect.stringContaining('preserve the public signature'),
    ]);
  });

  it('leaves a message from a failed retry pending for the retry path', async () => {
    const ref = setupProject(directories);
    const task = makeTask();
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: async () => {
        enqueueUserMessage({
          ...ref,
          state,
          bus,
          phase: 'implementing',
          message: plainUserMessage('keep this pending'),
        });
        return {
          success: false,
          output: 'bad code',
          error: 'invalid code',
          outcome: 'implementer-effect-invalid',
        };
      },
    });
    const invoker = makeImplementerRetryInvoker({
      context: defaultContext,
      kind: 'local',
      sessionId: ref.sessionId,
      languageContext: buildLanguageContext('typescript'),
      phase: 'implementing',
    });

    const result = await invoker({
      task,
      lastError: 'check failed',
      attempts: 2,
      projectDir: ref.projectDir,
      implementer,
      config: makeConfig(),
      seat: { ref: { ...ref, bus }, state, usageCategory: 'implementer' },
    });

    expect(result.success).toBe(false);
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(loadState(ref)?.messageQueue[0]?.deliveredTo?.implementer).toBeUndefined();
  });
});
