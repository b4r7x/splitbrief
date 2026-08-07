import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePreparedImplementerFactory,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { decideValidationAcceptance } from '../validation/acceptance.js';
import type { Validator } from '../validation/types.js';
import { retryAndRecord } from './retry.js';

// Escalation tiers run a full recursive createStagedProject copy; under parallel
// full-suite load that staged-copy IO can push these cases past the 10s default,
// so widen the timeout for this file (cases pass in seconds in isolation).
vi.setConfig({ testTimeout: 30_000 });

let savedOpenRouterKey: string | undefined;

const preparedIntermediateFactory = makePreparedImplementerFactory({
  preparationId: 'retry-intermediate-preparation',
  slot: { role: 'intermediate' },
  gates: [
    {
      kind: 'api',
      slot: { role: 'intermediate' },
      preparationId: 'retry-intermediate-preparation',
      provider: 'openrouter',
      endpointOrigin: 'https://openrouter.ai',
    },
  ],
});

beforeEach(() => {
  savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
  cleanupTaskProjects();
});

describe('retryAndRecord — retry budget', () => {
  it('local retry on first attempt succeeds → advances task, records local method', async () => {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({ callbacks, implementer, bus });
    const setTrackedState = vi.fn();
    const taskBreakdowns: TaskTokenUsage[] = [];

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'tsc failed',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns,
      setTrackedState,
    });

    expect(res.completed).toBe(true);
    expect(res.state.tasks[0]?.status).toBe('done');
    expect(res.state.currentTaskIndex).toBe(1);

    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const firstRetry = retryEvents[0];
    if (firstRetry?.type === 'task_retry') {
      expect(firstRetry.taskId).toBe('T001');
      expect(firstRetry.attempt).toBe(1);
    }

    expect(taskBreakdowns[0]?.method).toBe('local');
  });

  it('keeps initial failure evidence distinct from successful retry validation', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/task.ts' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockImplementation(async ({ projectDir: retryDir }: { projectDir: string }) => {
          mkdirSync(join(retryDir, 'src'), { recursive: true });
          writeFileSync(join(retryDir, task.file), 'recovered implementation');
          return {
            success: true,
            output: 'fixed',
            usage: { inputTokens: 20, outputTokens: 10 },
          };
        }),
    });
    const validator: Validator = {
      primeBaseline: vi.fn().mockResolvedValue(undefined),
      runValidation: vi.fn().mockResolvedValue([{ stage: 'test' as const, passed: true }]),
      decideAcceptance: ({ results, changedFiles }) =>
        decideValidationAcceptance({
          results,
          changedFiles,
          baselineFailingStages: new Set<ValidationStage>(),
        }),
    };

    const result = await retryAndRecord({
      wctx: makeWorkflowContext({ projectDir, sessionId, implementer, validator }),
      task,
      initialError: 'test failed',
      initialValidation: [{ stage: 'test', passed: false, error: 'initial failed' }],
      initialChangedFiles: ['src/initial.ts'],
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(true);
    expect(readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.validation).toEqual([
      {
        stage: 'test',
        passed: false,
        errorSummary: 'initial failed',
        retryState: 'initial-failure',
        changedFiles: ['src/initial.ts'],
      },
      {
        stage: 'test',
        passed: true,
        retryState: 'retry',
        changedFiles: ['src/task.ts'],
      },
    ]);
    expect(readEvidenceLedger({ projectDir, sessionId })?.tasks[0]?.changedFiles).toEqual([
      'src/initial.ts',
      'src/task.ts',
    ]);
  });

  it('stamps the initial-failure entry with the initial acceptance, not the retry acceptance', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/task.ts' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const implementer = makeImplementer({
      retry: vi
        .fn()
        .mockImplementation(async ({ projectDir: retryDir }: { projectDir: string }) => {
          mkdirSync(join(retryDir, 'src'), { recursive: true });
          writeFileSync(join(retryDir, task.file), 'recovered implementation');
          return {
            success: true,
            output: 'fixed',
            usage: { inputTokens: 20, outputTokens: 10 },
          };
        }),
    });
    const validator: Validator = {
      primeBaseline: vi.fn().mockResolvedValue(undefined),
      runValidation: vi
        .fn()
        .mockResolvedValue([
          { stage: 'test' as const, passed: false, failureFiles: ['src/unrelated.ts'] },
        ]),
      decideAcceptance: ({ results, changedFiles }) =>
        decideValidationAcceptance({
          results,
          changedFiles,
          baselineFailingStages: new Set<ValidationStage>(['test']),
        }),
    };

    const result = await retryAndRecord({
      wctx: makeWorkflowContext({ projectDir, sessionId, implementer, validator }),
      task,
      initialError: 'test failed',
      initialValidation: [{ stage: 'test', passed: false, error: 'initial failed' }],
      initialChangedFiles: ['src/initial.ts'],
      initialExemptStages: [],
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(true);
    const ledger = readEvidenceLedger({ projectDir, sessionId });
    expect(ledger?.tasks[0]?.validation).toEqual([
      {
        stage: 'test',
        passed: false,
        errorSummary: 'initial failed',
        retryState: 'initial-failure',
        changedFiles: ['src/initial.ts'],
      },
      {
        stage: 'test',
        passed: false,
        baselineExempt: true,
        retryState: 'retry',
        changedFiles: ['src/task.ts'],
      },
    ]);
    expect(ledger?.tasks[0]?.observedEvidence).toContain('test failed (pre-existing)');
  });

  it('exhausts local retry budget and persists recovery when escalation also fails', async () => {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'still broken',
      error: 'tsc failed again',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      escalateFull: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({
      callbacks,
      implementer,
      planner,
      bus,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 2 },
      }),
    });

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial tsc failure',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(res.completed).toBe(false);
    expect(res.state.tasks[0]?.status).toBe('in_progress');
    expect(res.state.currentTaskIndex).toBe(0);
    expect(res.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(wctx)?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });

    const complete = busEvents.find((e) => e.type === 'task_completed');
    expect(complete).toBeUndefined();
    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe('retryAndRecord — recovery stop points', () => {
  it('persists pending recovery when retry or escalation throws before returning a result', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('planner crashed')),
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      bus,
      planner,
      implementer,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 0 },
      }),
    });

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'retry-exhausted',
        taskId: 'T001',
        availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'abort-workflow'],
      }),
    );
  });

  it('returns without raising recovery when retry or escalation throws an AbortError', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events } = makeBusRecorder();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(abortError),
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      bus,
      planner,
      implementer,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 0 },
      }),
    });

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.pendingRecovery).toBeUndefined();
    expect(events.find((e) => e.type === 'recovery_prompted')).toBeUndefined();
  });

  it('adds recovery to the latest persisted retry state when a later retry step throws', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'retry still failed',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('hint planner crashed')),
    });
    const wctx = makeWorkflowContext({
      bus,
      implementer,
      planner,
      projectDir,
      sessionId,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 1 },
      }),
    });

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.state.attempt).toBe(1);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      attempts: 1,
    });
    expect(loadState({ projectDir, sessionId })).toMatchObject({
      attempt: 1,
      pendingRecovery: expect.objectContaining({ reason: 'retry-exhausted' }),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'recovery_prompted',
        reason: 'retry-exhausted',
        taskId: 'T001',
      }),
    );
  });
});

describe('retryAndRecord — escalated-intermediate booking identity', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('books the per-task record under the intermediate provider/model, not the primary implementer', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/intermediate.ts', action: 'create' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const code = '```typescript\nexport const fixed = true;\n```';
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeOpenAiSseResponse([
        { content: code },
        { usage: { prompt_tokens: 400, completion_tokens: 200 } },
      ]),
    );

    // Local retries all fail so escalation reaches the intermediate tier.
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: '',
        error: 'still broken',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      createImplementer: preparedIntermediateFactory,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { maxRetries: 1 },
        escalation: {
          intermediateProvider: 'openrouter',
          intermediateModel: 'x-ai/grok-4-fast',
          enabled: true,
        },
      }),
    });
    const taskBreakdowns: TaskTokenUsage[] = [];

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'type error',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns,
      setTrackedState: vi.fn(),
    });

    expect(res.completed).toBe(true);
    const record = taskBreakdowns[0];
    expect(record?.method).toBe('escalated-intermediate');
    expect(record?.tool).toBe('openrouter');
    expect(record?.model).toBe('x-ai/grok-4-fast');
    expect(record?.implementerTokens).toBeGreaterThanOrEqual(600);
  });
});
