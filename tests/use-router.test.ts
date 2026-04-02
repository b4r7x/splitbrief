import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { useRouter } from '../src/hooks/use-router.js';
import type { Summary, WorkflowState } from '../src/types.js';

// Minimal renderHook for Ink — renders a component that calls the hook
// and exposes the return value via a mutable ref.
function renderHook<T>(hookFn: () => T) {
  const resultRef: { current: T | null } = { current: null };

  function HookHost() {
    const value = hookFn();
    resultRef.current = value;
    return null;
  }

  const stdout = new PassThrough();
  const inst = render(React.createElement(HookHost), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });

  function act(fn: () => void) {
    fn();
    return new Promise<void>(resolve => setTimeout(resolve, 10));
  }

  function unmount() {
    inst.unmount();
  }

  return { result: resultRef as { current: T }, act, unmount };
}

const dummySummary: Summary = {
  feature: 'test',
  totalTasks: 1,
  completedByLocal: 1,
  escalatedToPlanner: 0,
  skipped: 0,
  failed: 0,
  totalTime: 1000,
  tokenUsage: {
    plannerInput: 0,
    plannerOutput: 0,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 0,
    escalationOutput: 0,
  },
  estimatedCostSavings: '$0.00',
  escalationRate: 0,
};

describe('useRouter', () => {
  it('defaults to home screen', () => {
    const { result, unmount } = renderHook(() => useRouter());
    assert.equal(result.current.screen, 'home');
    assert.deepEqual(result.current.routeData, { screen: 'home' });
    unmount();
  });

  it('navigates from home to workflow with feature data', async () => {
    const { result, act, unmount } = renderHook(() => useRouter());

    assert.equal(result.current.screen, 'home');

    await act(() => {
      result.current.navigate('workflow', { feature: 'auth' });
    });

    assert.equal(result.current.screen, 'workflow');
    assert.deepEqual(result.current.routeData, {
      screen: 'workflow',
      feature: 'auth',
      resumeState: undefined,
    });
    unmount();
  });

  it('navigates from workflow to summary with summary data', async () => {
    const { result, act, unmount } = renderHook(() =>
      useRouter({ screen: 'workflow', feature: 'auth' }),
    );

    assert.equal(result.current.screen, 'workflow');

    await act(() => {
      result.current.navigate('summary', { summary: dummySummary });
    });

    assert.equal(result.current.screen, 'summary');
    assert.deepEqual(result.current.routeData, {
      screen: 'summary',
      summary: dummySummary,
    });
    unmount();
  });

  it('navigates from summary to home', async () => {
    const { result, act, unmount } = renderHook(() =>
      useRouter({ screen: 'summary', summary: dummySummary }),
    );

    assert.equal(result.current.screen, 'summary');

    await act(() => {
      result.current.navigate('home');
    });

    assert.equal(result.current.screen, 'home');
    assert.deepEqual(result.current.routeData, { screen: 'home' });
    unmount();
  });

  it('navigates from summary to workflow (resume)', async () => {
    const resumeState: WorkflowState = {
      stateVersion: 1,
      phase: 'implementing',
      feature: 'auth',
      currentTaskIndex: 2,
      attempt: 0,
      tasks: [],
      completedTasks: ['t1'],
      escalatedTasks: [],
      skippedTasks: [],
      failedTasks: [],
      sessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
    };

    const { result, act, unmount } = renderHook(() =>
      useRouter({ screen: 'summary', summary: dummySummary }),
    );

    await act(() => {
      result.current.navigate('workflow', { feature: 'auth', resumeState });
    });

    assert.equal(result.current.screen, 'workflow');
    assert.deepEqual(result.current.routeData, {
      screen: 'workflow',
      feature: 'auth',
      resumeState,
    });
    unmount();
  });

  it('throws on invalid transition from home to summary', () => {
    const { result, unmount } = renderHook(() => useRouter());

    assert.throws(() => {
      result.current.navigate('summary', { summary: dummySummary });
    }, /Cannot navigate from "home" to "summary"/);
    unmount();
  });

  it('guards invalid transitions internally', () => {
    const { result, unmount } = renderHook(() => useRouter());

    assert.throws(() => {
      result.current.navigate('summary', { summary: dummySummary });
    }, /Cannot navigate from "home" to "summary"/);
    unmount();
  });
});
