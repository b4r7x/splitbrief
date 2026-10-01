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
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ImplementerResult } from '../../implementers/types.js';
import type { RunImplementationResult } from './run-implementation.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { handleFailedImplementation } from './implementation-failure.js';

afterEach(cleanupTaskProjects);

function implState(implResult: ImplementerResult): RunImplementationResult {
  return {
    state: implementingState([makeTask()]),
    implResult,
    workspace: undefined,
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

describe('handleFailedImplementation — a stop with a hand-back goes to the planner first', () => {
  it('forwards the tail of the implementer output and skips the local rung', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const implementer = makeImplementer({ retry: vi.fn() });
    const hint = 'VERDICT: brief — the prop was removed in T000';
    const escalateHint = vi
      .fn()
      .mockResolvedValue({ success: true, output: hint, code: null, usage: null });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ implementer, planner: makePlanner({ escalateHint }), bus });

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

    expect(implementer.retry).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'task_retry')).toBeUndefined();
    const handBack = escalateHint.mock.calls[0]?.[0]?.handBack;
    expect(handBack).toHaveLength(2000);
    expect(handBack?.endsWith('I could not find the prop.')).toBe(true);
    expect(next.pendingRecovery).toMatchObject({ reason: 'retry-exhausted', taskId: 'T001' });
    expect(next.pendingRecovery?.details).toContain(
      'Planner verdict: the brief itself is wrong — the prop was removed in T000',
    );
    expect(next.pendingRecovery?.details.some((row) => row.startsWith('Implementer said:'))).toBe(
      true,
    );
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
        workflow: { maxRetries: 1 },
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
});
