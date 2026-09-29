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
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { ValidationStage } from '../../../core/schemas/enums.js';
import { decideValidationAcceptance } from '../validation/acceptance.js';
import type { Validator } from '../validation/types.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { handleRetryAndEscalation } from '../escalation/handle.js';
import { failedRetry, type RetryResult } from '../escalation/types.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool-catalog.js';
import { error } from '../../../utils/error.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { retryAndRecord } from './retry.js';

vi.mock('../escalation/handle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../escalation/handle.js')>();
  return { ...actual, handleRetryAndEscalation: vi.fn(actual.handleRetryAndEscalation) };
});

// Escalation tiers run a full recursive createStagedProject copy; under parallel
// full-suite load that staged-copy IO can push these cases past the 10s default,
// so widen the timeout for this file (cases pass in seconds in isolation).
vi.setConfig({ testTimeout: 30_000 });

const preparedIntermediateFactory = makePreparedImplementerFactory({
  preparationId: 'retry-intermediate-preparation',
  slot: { role: 'intermediate' },
  gates: [
    {
      kind: 'api',
      slot: { role: 'intermediate' },
      preparationId: 'retry-intermediate-preparation',
      provider: 'ollama',
      endpointOrigin: 'http://localhost:11434',
    },
  ],
});

afterEach(() => {
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
    expect(retryEvents[0]).toMatchObject({ taskId: 'T001', attempt: 1 });

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

  it('exhausts the retry budget and persists recovery without handing the brief to the planner', async () => {
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
    const escalateFull = vi.fn();
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      escalateFull,
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
      // 2 local retries; the empty hint made no implementer call and spent no attempt.
      attempts: 2,
      availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'end-run'],
    });
    expect(escalateFull).not.toHaveBeenCalled();
    expect(loadState(wctx)?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });

    const complete = busEvents.find((e) => e.type === 'task_completed');
    expect(complete).toBeUndefined();
    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('error event on exhaustion', async () => {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events: busEvents } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' }),
    });
    const planner = makePlanner({
      escalateHint: vi
        .fn()
        .mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const wctx = makeWorkflowContext({
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
    const errorIndex = busEvents.findIndex(
      (e) => e.type === 'error' && e.code === 'retry_exhausted' && e.category === 'recovery',
    );
    const promptedIndex = busEvents.findIndex((e) => e.type === 'recovery_prompted');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(promptedIndex).toBeGreaterThan(errorIndex);

    const ledger = readEvidenceLedger(wctx);
    expect(ledger?.tasks.find((t) => t.id === 'T001')?.status).toBe('failed');
  });
});

describe('retryAndRecord — the exhaustion issue', () => {
  const lintFailure = { stage: 'lint' as const, passed: false, error: 'lint: unexpected any' };

  function stubLadder(result: RetryResult, pendingRecovery?: RecoveryIssue) {
    vi.mocked(handleRetryAndEscalation).mockImplementationOnce(async ({ currentState }) => ({
      state: pendingRecovery === undefined ? currentState : { ...currentState, pendingRecovery },
      result,
    }));
  }

  async function exhaust(result: RetryResult, pendingRecovery?: RecoveryIssue) {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ bus });
    stubLadder(result, pendingRecovery);

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'lint: unexpected any',
      initialValidation: [lintFailure],
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
    return { res, events, wctx };
  }

  it('shows the error the brief actually died on and still records the first one', async () => {
    const { res, wctx } = await exhaust(
      failedRetry(3, { lastError: 'tsc: Type X is not assignable to Y' }),
    );

    expect(res.state.pendingRecovery?.details[0]).toBe(
      'Last error: tsc: Type X is not assignable to Y',
    );
    expect(res.state.pendingRecovery?.facts?.validationSummary).toBe(
      'tsc: Type X is not assignable to Y',
    );
    expect(JSON.stringify(res.state.pendingRecovery)).not.toContain('lint: unexpected any');
    expect(readEvidenceLedger(wctx)?.tasks[0]?.validation?.[0]).toMatchObject({
      stage: 'lint',
      errorSummary: 'lint: unexpected any',
      retryState: 'initial-failure',
    });
  });

  it('falls back to the initial validation when the ladder names no last error', async () => {
    const { res } = await exhaust(failedRetry(2));

    expect(res.state.pendingRecovery?.details[0]).toBe(
      'Last error: lint failed: lint: unexpected any',
    );
    expect(res.state.pendingRecovery?.facts?.validationStage).toBe('lint');
  });

  it('hands the builder both voices and the hint-rung flag', async () => {
    const { res } = await exhaust(
      failedRetry(4, { lastError: 'E', handBack: 'H', plannerHint: 'P', hintRungRan: true }),
    );

    expect(res.state.pendingRecovery?.details).toEqual([
      'Last error: E',
      'Attempts: 4 (3 local, then 1 with planner hints)',
      'Implementer said: H',
      'Planner said: P',
    ]);
    expect(res.state.pendingRecovery?.facts?.hintRungRan).toBe(true);
  });

  it('leaves a recovery the ladder already raised untouched', async () => {
    const existing = makeRecoveryIssue({ id: 'rec_from_the_ladder' });
    const { res, events } = await exhaust(failedRetry(1, { lastError: 'E' }), existing);

    expect(res.state.pendingRecovery).toBe(existing);
    expect(events.find((e) => e.type === 'recovery_prompted')).toBeUndefined();
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
      availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'end-run'],
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
        availableActions: ['retry-same-worker', 'skip-current-task', 'pause-run', 'end-run'],
      }),
    );
  });

  it('a thrown escalation still records failed evidence', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('planner crashed')),
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      bus: makeBusRecorder().bus,
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
    expect(
      readEvidenceLedger({ projectDir, sessionId })?.tasks.find((t) => t.id === 'T001'),
    ).toMatchObject({ status: 'failed', method: 'failed' });
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
    // A failure that names no planner call is the retry's own.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Retrying T001 failed: hint planner crashed',
      }),
    );
  });
});

// Captured from `codex exec --json` against an account at its usage limit; the hint call wraps it
// the way `requireCompletedCall` does.
const CODEX_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 1:02 PM.";
// Captured from `codex exec --json` (codex-cli 0.146.0, 2026-08-06) against a dead login.
const CODEX_SIGNED_OUT =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

describe('retryAndRecord — a planner out of quota on the hint', () => {
  const config = makeConfig({
    planner: { kind: 'cli', tool: 'codex', authChannel: defaultCliAuthChannel('codex').id },
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
    workflow: { maxRetries: 0 },
  });

  async function hintHalted(words = CODEX_LIMIT) {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['codex', 'claude-code']));
    const task = makeTask({ id: 'T001', file: 'src/alpha.ts' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(
        error('runner-call-failed', 'Planner escalation call failed', {
          role: 'escalation',
          status: 'failed',
          error: { code: 'codex-turn-failed', message: words },
        }),
      ),
    });
    const result = await retryAndRecord({
      wctx: makeWorkflowContext({
        projectDir,
        sessionId,
        bus,
        planner,
        implementer: makeImplementer({ retry: vi.fn() }),
        config,
      }),
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
    return { projectDir, sessionId, result, events };
  }

  it('halts on the plan seat with the reset, naming the brief, instead of exhausting it', async () => {
    const { projectDir, sessionId, result, events } = await hintHalted();

    const issue = result.state.pendingRecovery;
    expect(result.completed).toBe(false);
    expect(issue).toMatchObject({
      reason: 'runner-usage-limit',
      seat: 'plan',
      taskId: 'T001',
      files: ['src/alpha.ts'],
      affectedTaskIds: ['T001'],
      switchSeat: { seat: 'plan', candidates: [{ tool: 'claude-code' }] },
      availableActions: [
        'retry-same-worker',
        'switch-seat',
        'skip-current-task',
        'pause-run',
        'end-run',
      ],
      recommendedAction: 'switch-seat',
      facts: { tool: 'OpenAI Codex CLI' },
    });
    expect(new Date(issue?.resetAt ?? '')).toEqual(new Date(2026, 9, 3, 13, 2));
    expect(issue?.details).toEqual([
      `OpenAI Codex CLI reported: ${CODEX_LIMIT}`,
      'The planner could not write the hint for T001.',
    ]);
    expect(issue?.message).toContain('hit its usage limit');
    expect(loadState({ projectDir, sessionId })?.pendingRecovery?.reason).toBe(
      'runner-usage-limit',
    );
    // The error row carries the halt's reset for the row to spell; its words name no clock, and
    // codex's own words drop theirs.
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.resetAt).toBe(issue?.resetAt);
    const row = published?.type === 'error' ? published.message : '';
    expect(row).toMatch(/^Planner hint for T001 failed: You've hit your usage limit\./);
    expect(row).not.toMatch(/13:02|1:02 PM|try again/);
    expect(
      readEvidenceLedger({ projectDir, sessionId })?.tasks.find((t) => t.id === 'T001'),
    ).toMatchObject({ status: 'failed', method: 'failed' });
  });

  it('moves the planner block and replays the brief on the new tool', async () => {
    const { projectDir, sessionId, result } = await hintHalted();
    const { bus, events } = makeBusRecorder();

    const moved = applyRecoveryAction({
      projectDir,
      sessionId,
      state: result.state,
      action: 'switch-seat',
      candidate: { tool: 'claude-code', model: 'opus' },
      bus,
      config,
    });

    expect(moved).toMatchObject({ ok: true, status: 'retry-current-task' });
    if (!moved.ok) throw new Error('expected the swap to apply');
    expect(moved.switchedConfig?.planner).toMatchObject({ tool: 'claude-code', model: 'opus' });
    expect(moved.switchedConfig?.implementer).toEqual(config.implementer);
    expect(events).toContainEqual(expect.objectContaining({ type: 'task_reset', taskId: 'T001' }));
    expect(moved.state.pendingRecovery).toBeUndefined();
  });

  it('halts a signed-out planner on the plan seat with the login, naming the brief', async () => {
    const { result, events } = await hintHalted(CODEX_SIGNED_OUT);

    const issue = result.state.pendingRecovery;
    expect(issue).toMatchObject({
      reason: 'runner-unauthenticated',
      seat: 'plan',
      taskId: 'T001',
      recommendedAction: 'retry-same-worker',
    });
    expect(issue?.availableActions).toContain('skip-current-task');
    expect(issue?.message).toContain('`codex logout` then `codex login`');
    expect(issue?.message).not.toContain('usage limit');
    expect(issue?.details).toContain(`OpenAI Codex CLI reported: ${CODEX_SIGNED_OUT}`);
    const published = events.find((event) => event.type === 'error');
    expect(published?.type === 'error' && published.message).toContain('codex login');
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
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', file: 'src/intermediate.ts', action: 'create' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const code = JSON.stringify({
      version: 1,
      files: [
        { path: 'src/intermediate.ts', action: 'create', content: 'export const fixed = true;\n' },
      ],
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      withLocalCatalog(['x-ai/grok-4-fast'], () =>
        makeOpenAiSseResponse([
          { content: code },
          { usage: { prompt_tokens: 400, completion_tokens: 200 } },
        ]),
      ),
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
          intermediateProvider: 'ollama',
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
    expect(record?.tool).toBe('ollama');
    expect(record?.model).toBe('x-ai/grok-4-fast');
    expect(record?.implementerTokens).toBeGreaterThanOrEqual(600);
  });
});
