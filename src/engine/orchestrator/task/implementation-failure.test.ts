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
      message: `T001 left the isolation directory — Ollama ${evidence}`,
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: `T001 left the isolation directory — Ollama ${evidence}`,
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
      message: 'Your checkout changed under T001 — branch escaped',
      recommendedAction: 'retry-same-worker',
    });
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: 'Your checkout changed under T001 — branch escaped',
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
    const task = makeTask({ id: 'T001', action: 'create', file: 'src/hello.ts' });
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
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
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
    const task = makeTask({ id: 'T001', file: 'src/app.ts' });
    const state = implementingState([task]);
    const retry = vi.fn().mockResolvedValue({
      success: false,
      error: 'still blocked',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      implementer: makeImplementer({ retry }),
      bus,
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
    });
    const error = extractedCodeApprovalRaceError(task.file);

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
    expect(events.find((e) => e.type === 'paused_external_changes')).toBeUndefined();
  });
});
