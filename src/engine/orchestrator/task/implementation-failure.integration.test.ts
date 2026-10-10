import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { RunImplementationResult } from './run-implementation.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { extractedCodeApprovalRaceError } from '../../implementers/pipeline/extracted-code.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { writeConfig } from '../../../core/config/load/io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';

afterEach(cleanupTaskProjects);

function implState(implResult: ImplementerResult): RunImplementationResult {
  return {
    state: implementingState([makeTask()]),
    implResult,
    workspace: {
      projectDir: '/unused',
      sandboxEnv: {},
      snapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      targetBaseline: undefined,
      changedFiles: async () => [],
      cleanup: () => {},
      revert: async () => {},
    },
    preApplyApprovalDenied: false,
    preApplyApprovedFiles: [],
  };
}

describe('handleFailedImplementation — runner defects halt before the ladder', () => {
  it('unknown flag does not consume a retry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-recipe-invalid',
        error: 'error: unknown flag --print-timeout',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'implementer-recipe-invalid',
      taskId: 'T001',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
  });

  it('an implementer that left its isolation directory halts on the evidence', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });
    const evidence = 'searched ~ with run_command: find ~ -name x';

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-left-isolation',
        error: evidence,
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'implementer-left-isolation',
      taskId: 'T001',
      message: `T001 left the isolation directory · Ollama ${evidence}`,
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: `T001 left the isolation directory · Ollama ${evidence}`,
      }),
    );
  });

  it('a checkout whose git state changed during the call halts without blaming the tool', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, bus });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'checkout-changed',
        error: 'branch escaped',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery).toMatchObject({
      reason: 'checkout-changed',
      taskId: 'T001',
      message: 'Repository changed under T001 · branch escaped',
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Repository changed under T001 · branch escaped',
      }),
    );
  });

  it('a model the tool does not list halts with the same reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'missing-model',
        error: 'model not found',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('implementer-recipe-invalid');
  });

  it('a brief that already timed out twice halts on its own reason', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({ implementer });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'runner-timeout-repeated',
        error: 'implementer timed out',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(next.pendingRecovery?.reason).toBe('runner-timeout-repeated');
  });
});

// Recorded on 2026-10-05: the `runner_call_error` of opencode with `deepseek/deepseek-flash` on a
// spent DeepSeek account, which the run retried once and then consulted the planner on.
const OPENCODE_DEEPSEEK_BALANCE =
  'provider.quota: Insufficient Balance (request_id: 021cfcdf-894e-4f9c-8e1b-85ac99f6a0fe)';

describe('handleFailedImplementation — an account the provider refuses is a seat-down halt', () => {
  async function haltOn(message: string) {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' },
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'opencode-error', message },
        backendKind: 'cli',
      }),
    );

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        error: message,
        ...(outcome.state !== 'success' && { outcome: outcome.state }),
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
    return { next, events, implementer };
  }

  it('halts on the spent balance at once: no retry, no consult, the seat switch first', async () => {
    const { next, events, implementer } = await haltOn(OPENCODE_DEEPSEEK_BALANCE);

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'task_retry')).toEqual([]);
    expect(events.filter((e) => e.type === 'task_escalating')).toEqual([]);
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
    expect(next.pendingRecovery).toMatchObject({
      reason: 'runner-usage-limit',
      taskId: 'T001',
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    expect(next.pendingRecovery?.resetAt).toBeUndefined();
    expect(next.pendingRecovery?.availableActions).toContain('end-run');
    const row = events.find((e) => e.type === 'error');
    expect(row?.type === 'error' && row.message).toContain(OPENCODE_DEEPSEEK_BALANCE);
  });

  it('halts a refused login at once and offers the seat switch beside it', async () => {
    const { next, events, implementer } = await haltOn('HTTP 403 Forbidden');

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'consult_answered')).toEqual([]);
    expect(next.pendingRecovery).toMatchObject({
      reason: 'runner-unauthenticated',
      switchSeat: { seat: 'build', candidates: [{ tool: 'claude-code' }] },
    });
    expect(next.pendingRecovery?.availableActions).toEqual(
      expect.arrayContaining(['switch-seat', 'end-run']),
    );
    const row = events.find((e) => e.type === 'error');
    expect(row?.type === 'error' && row.message).toContain('HTTP 403 Forbidden');
  });
});

describe('handleFailedImplementation — the automatic seat switch intent', () => {
  async function haltWith(state: WorkflowState) {
    const { projectDir, sessionId } = setupProject();
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'opencode',
        model: 'deepseek/deepseek-flash',
        fallback: { tool: 'claude-code' },
      },
      validation: { endChecks: false, testCommand: 'noop' },
    });
    writeConfig(projectDir, config);
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const task = makeTask({ id: 'T001' });
    const implementer = makeImplementer({ retry: vi.fn() });
    const { bus } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config,
    });

    return handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        error: OPENCODE_DEEPSEEK_BALANCE,
        outcome: 'usage-limit',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });
  }

  it('carries the fallback and config hash when the seat can move itself', async () => {
    const next = await haltWith(implementingState([makeTask({ id: 'T001' })]));

    const auto = next.pendingRecovery?.switchSeat?.auto;
    expect(auto?.candidate).toEqual({ tool: 'claude-code' });
    expect(auto?.configRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('offers no automatic switch when this run already switched the seat', async () => {
    const state: WorkflowState = {
      ...implementingState([makeTask({ id: 'T001' })]),
      seatSwitches: [
        {
          seat: 'build',
          from: 'opencode',
          to: 'claude-code',
          cause: 'runner-usage-limit',
          auto: true,
          configRevision: 'abc',
          ts: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    const next = await haltWith(state);

    expect(next.pendingRecovery?.switchSeat?.auto).toBeUndefined();
    expect(next.pendingRecovery?.switchSeat?.candidates).toEqual([{ tool: 'claude-code' }]);
  });
});

describe('handleFailedImplementation — a stop with a hand-back is consulted', () => {
  it('ends the local rung on a no-change retry and asks the planner', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: 'I could not find the prop.',
        outcome: 'no-staged-change',
        error: 'exited without changing any files',
      }),
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
    });

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: `${'x'.repeat(3000)}\nI could not find the prop.`,
        outcome: 'no-staged-change',
        error: 'exited without changing any files',
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    // One local retry stopped on the no-change outcome; the two consult answers
    // each spent one attempt before the lineage bound halted the ladder.
    expect(implementer.retry).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'task_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'consult_answered')).toHaveLength(2);
    expect(next.pendingRecovery).toMatchObject({ reason: 'consult-bound-spent', taskId: 'T001' });
  });
});

describe('handleFailedImplementation — an effect failure is no scope fence', () => {
  it('retries on the runner error and never sends a revert instruction', async () => {
    const { projectDir, sessionId } = setupProject({ 'src/other.ts': 'committed other\n' });
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/hello.ts'] });
    const state = implementingState([task]);
    const taskStartSnapshot = await getChangedFilesSnapshot(projectDir);
    writeFileSync(join(projectDir, 'src/other.ts'), 'agent rewrote this\n');

    const retry = vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken' });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: makeImplementer({ retry }),
      bus,
      config: makeConfig({
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });
    const error = "Tool implementer wrote outside the brief's declared files: src/other.ts";

    await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({
        success: false,
        output: '',
        outcome: 'implementer-effect-invalid',
        error,
      }),
      taskStartTime: Date.now(),
      taskStartSnapshot,
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(retry.mock.calls[0]?.[0]?.error).toBe(error);
    expect(readFileSync(join(projectDir, 'src/other.ts'), 'utf-8')).toBe('agent rewrote this\n');
    expect(JSON.stringify(events)).not.toMatch(/revert/i);
  });

  it('an extracted-code write blocked by a change during approval is an ordinary failed attempt', async () => {
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/app.ts'] });
    const state = implementingState([task]);
    const retry = vi.fn().mockResolvedValue({
      success: false,
      error: 'still blocked',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const { bus } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      implementer: makeImplementer({ retry }),
      bus,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
    });
    const error = extractedCodeApprovalRaceError(task.suggestedFiles[0]);

    const next = await handleFailedImplementation({
      wctx,
      task,
      state,
      implState: implState({ success: false, output: '', error }),
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(retry.mock.calls[0]?.[0]?.error).toBe(error);
    expect(next.pendingRecovery?.reason).not.toBe('approval-promotion-conflict');
  });
});
