import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '#testing/helpers/render-hook.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';
import type { RunWorkflowOptions } from '../engine/orchestrator/run.js';

const { runWorkflowMock } = vi.hoisted(() => ({
  runWorkflowMock: vi.fn<(opts: RunWorkflowOptions) => Promise<never>>(() => new Promise<never>(() => {})),
}));

vi.mock('../engine/orchestrator/index.js', () => ({
  runWorkflow: runWorkflowMock, // never resolves — simulates a running workflow
}));

vi.mock('../utils/process-lifecycle.js', () => ({
  killAllProcesses: vi.fn(),
}));

import { useWorkflow } from './use-workflow.js';
import { workflowStore } from '../stores/workflow.js';

describe('useWorkflow', () => {
  beforeEach(() => {
    workflowStore.reset();
    runWorkflowMock.mockClear();
  });
  it('does not call onComplete on mount', () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { unmount } = renderHook(() =>
      useWorkflow({
        feature: 'test',
        projectDir: '/tmp/proj',
        config,
        onComplete,
      }),
    );

    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it('accepts resumeState and reflects initial task index', () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { unmount } = renderHook(() =>
      useWorkflow({
        feature: 'auth',
        projectDir: '/tmp/proj',
        config,
        onComplete,
        initialResumeState: {
          stateVersion: 1,
          phase: 'implementing',
          feature: 'auth',
          currentTaskIndex: 3,
          attempt: 0,
          tasks: [
            makeTask({ id: 'T1', title: 'a', file: 'a.ts', status: 'done' }),
            makeTask({ id: 'T2', title: 'b', file: 'b.ts', status: 'done' }),
            makeTask({ id: 'T3', title: 'c', file: 'c.ts', status: 'done' }),
            makeTask({ id: 'T4', title: 'd', file: 'd.ts', status: 'pending' }),
          ],
          sessionId: null,
          startedAt: new Date().toISOString(),
          tokenUsage: { plannerInput: 0, plannerOutput: 0, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
        },
      }),
    );

    // Workflow state is read directly from the store by consumers; the hook
    // no longer re-exports it. Assert the store was seeded from resumeState.
    const state = workflowStore.get();
    expect(state.phase).toBe('implementing');
    expect(state.currentTask).toBe(3);
    expect(state.totalTasks).toBe(4);
    unmount();
  });

  it('requestCancel resolves an in-flight approval prompt and resets input mode', async () => {
    const config = makeConfig();
    const onComplete = vi.fn();

    const { result, act, unmount } = renderHook(() =>
      useWorkflow({
        feature: 'test',
        projectDir: '/tmp/proj',
        config,
        onComplete,
      }),
    );

    await act(() => {});
    const workflowCall = runWorkflowMock.mock.calls.at(0)?.[0];
    expect(workflowCall).toBeDefined();
    if (!workflowCall) throw new Error('expected runWorkflow call');

    const approvalPromise = workflowCall.callbacks.onApprovalNeeded('spec', '/tmp/spec.md');
    await act(() => {});
    expect(result.current.inputMode).toBe('review');

    await act(() => {
      workflowStore.requestCancel();
    });

    await expect(approvalPromise).resolves.toEqual({ approved: false });
    expect(result.current.inputMode).toBe('normal');
    unmount();
  });
});
