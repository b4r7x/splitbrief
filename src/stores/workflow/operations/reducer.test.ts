import { beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import type { RunnerCallWarningInput } from '../../../engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../../engine/calls/warnings.js';
import { addEvent } from '../actions/event.js';
import { hydrateFromState } from '../actions/hydrate.js';
import { markCancellationRequested } from '../actions/interrupt.js';
import { resetWorkflow } from '../actions/reset.js';
import { MAX_COMPLETED_OPERATIONS } from './retention.js';
import { operationsStore, selectScheduledReview } from './state.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeTaskStart, makeValidate } from '#testing/helpers/events/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';

it('retains admitted load metadata when cancellation finishes API waiting and ignores late status', () => {
  resetWorkflow();
  const started = runnerStarted({ backendKind: 'api', runnerName: 'lm-studio' });
  addEvent(started);
  const runtime = {
    ...started,
    type: 'runner_call_runtime_status',
    runtimeStatus: { phase: 'waiting-first-response', loadState: 'loaded', observedAt: 900 },
  } satisfies EngineEventOf<'runner_call_runtime_status'>;
  addEvent(runtime);
  expect(operationsStore.get().active?.apiRuntimeStatus).toEqual(runtime.runtimeStatus);
  markCancellationRequested({ ts: 1_200, reason: 'user_cancelled' });
  addEvent({
    ...runtime,
    ts: 1_300,
    runtimeStatus: { ...runtime.runtimeStatus, phase: 'streaming' },
  });
  expect(operationsStore.get().active).toBeNull();
  expect(operationsStore.get().last?.apiRuntimeStatus).toEqual({
    phase: 'finished',
    loadState: 'loaded',
    observedAt: 900,
  });
  resetWorkflow();
});

type RunnerCallFailureStatus = EngineEventOf<'runner_call_error'>['status'];

const runnerCallFailureStatuses: readonly RunnerCallFailureStatus[] = [
  'failed',
  'truncated',
  'aborted',
  'timeout',
  'refused',
  'unsupported_tool',
  'incomplete',
];

function runnerStarted(
  overrides?: Partial<EngineEventOf<'runner_call_started'>>,
): EngineEventOf<'runner_call_started'> {
  return {
    type: 'runner_call_started',
    ts: 1_000,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'xhigh',
    attempt: 0,
    sequence: 1,
    ...overrides,
  };
}

function runnerAborted(
  overrides?: Partial<EngineEventOf<'runner_call_error'>>,
): EngineEventOf<'runner_call_error'> {
  return {
    type: 'runner_call_error',
    ts: 1_900,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'xhigh',
    attempt: 0,
    sequence: 2,
    status: 'aborted',
    error: { code: 'aborted', message: 'cancelled by user' },
    partial: true,
    startedAt: 1_000,
    endedAt: 1_900,
    durationMs: 900,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}

function runnerCompleted(
  overrides?: Partial<EngineEventOf<'runner_call_completed'>>,
): EngineEventOf<'runner_call_completed'> {
  return {
    type: 'runner_call_completed',
    ts: 1_900,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'xhigh',
    attempt: 0,
    sequence: 2,
    status: 'completed',
    error: null,
    partial: false,
    startedAt: 1_000,
    endedAt: 1_900,
    durationMs: 900,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}

function runnerWarning(
  overrides?: Partial<Omit<EngineEventOf<'runner_call_warning'>, 'warning'>> & {
    warning?: RunnerCallWarningInput;
  },
): EngineEventOf<'runner_call_warning'> {
  const { warning, ...eventOverrides } = overrides ?? {};
  return {
    type: 'runner_call_warning',
    ts: 1_100,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    warning: normalizeRunnerCallWarning(warning ?? { code: 'stderr', message: 'warn' }),
    ...eventOverrides,
  };
}

function runnerActivity(
  overrides?: Partial<EngineEventOf<'runner_call_activity'>>,
): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 1_100,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    activityId: 'call-1:tool:a',
    stage: 'updated',
    kind: 'command',
    label: 'bash',
    target: 'npx vitest run',
    redacted: false,
    ...overrides,
  };
}

describe('the tools a running call has open', () => {
  beforeEach(() => resetWorkflow());

  it('keeps each tool from the activity that opens it until the activity that closes it', () => {
    addEvent(runnerStarted());
    addEvent(runnerActivity({ ts: 1_100 }));
    addEvent(
      runnerActivity({ ts: 1_200, activityId: 'call-1:tool:b', kind: 'read', target: 'a.ts' }),
    );
    addEvent(runnerActivity({ ts: 1_300, activityId: 'call-1:tool:b', stage: 'completed' }));
    addEvent(runnerActivity({ ts: 1_400 }));

    expect(operationsStore.get().active?.openTools).toEqual([
      {
        activityId: 'call-1:tool:a',
        kind: 'command',
        label: 'bash',
        target: 'npx vitest run',
        since: 1_100,
      },
    ]);
  });

  it('opens no tool for activity that is not one', () => {
    addEvent(runnerStarted());
    addEvent(
      runnerActivity({ activityId: 'call-1:system', kind: 'text', label: 'system activity' }),
    );

    expect(operationsStore.get().active?.openTools ?? []).toEqual([]);
  });
});

describe('the scheduled task review', () => {
  beforeEach(() => resetWorkflow());

  const reviewStarted = (scope: 'task' | 'final') =>
    addEvent({ type: 'review_started', ts: 1_000, phase: 'implementing', scope, tool: 'codex' });

  it('holds from a task review start through its verdict, a stop and a resume', () => {
    reviewStarted('task');
    addEvent({
      type: 'review_completed',
      ts: 2_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
      verdict: 'fail',
      duration: 1_000,
    });
    addEvent({ type: 'workflow_cancelled', ts: 3_000, phase: 'implementing' });
    addEvent({ type: 'workflow_resumed', ts: 4_000, phase: 'implementing' });

    expect(selectScheduledReview(operationsStore.get())).toBe(true);
  });

  it('ends when BUILD starts a brief or the review opens its fix cycle', () => {
    reviewStarted('task');
    addEvent(makeTaskStart({ ts: 2_000, taskId: taskId('T002') }));
    expect(selectScheduledReview(operationsStore.get())).toBe(false);

    reviewStarted('task');
    addEvent({
      type: 'review_fix_started',
      ts: 3_000,
      phase: 'implementing',
      cycle: 1,
      taskIds: [taskId('T003')],
    });
    expect(selectScheduledReview(operationsStore.get())).toBe(false);

    reviewStarted('task');
    addEvent({
      type: 'review_fix_started',
      ts: 4_000,
      phase: 'implementing',
      cycle: 2,
      taskIds: [],
    });
    expect(selectScheduledReview(operationsStore.get())).toBe(false);
  });

  it('ends when the user accepts a task review that is too large as is', () => {
    reviewStarted('task');
    addEvent({
      type: 'recovery_resolved',
      ts: 2_000,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'review-input-too-large',
      action: 'accept-as-is',
      outcome: 'continued',
    });

    expect(selectScheduledReview(operationsStore.get())).toBe(false);
  });

  it('is not set by a final review', () => {
    reviewStarted('final');

    expect(selectScheduledReview(operationsStore.get())).toBe(false);
  });
});

describe('operationsStore', () => {
  beforeEach(() => resetWorkflow());

  it('starts an active operation from runner_call_started', () => {
    addEvent(runnerStarted());

    expect(operationsStore.get().active).toMatchObject({
      callId: 'call-1',
      role: 'implementer',
      phase: 'implementing',
      status: 'running',
      startedAt: 1_000,
      runnerName: 'codex',
      model: 'xhigh',
    });
  });

  it('keeps the seat axis words the call started with, through to the terminal operation', () => {
    addEvent(runnerStarted({ runnerName: 'codex', model: 'gpt-6.1-sol', axes: ['high'] }));

    expect(operationsStore.get().active).toMatchObject({ model: 'gpt-6.1-sol', axes: ['high'] });

    addEvent(runnerCompleted());

    expect(operationsStore.get().last).toMatchObject({ axes: ['high'] });
  });

  it('carries a shell backend kind from an active operation into the terminal last operation', () => {
    addEvent(runnerStarted({ backendKind: 'shell', runnerName: 'bash' }));

    expect(operationsStore.get().active).toMatchObject({
      callId: 'call-1',
      backendKind: 'shell',
      status: 'running',
    });

    addEvent(runnerCompleted({ backendKind: 'shell', runnerName: 'bash' }));

    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      callId: 'call-1',
      backendKind: 'shell',
      status: 'completed',
    });
  });

  it('restores the newest still-running operation when the active call completes', () => {
    addEvent(
      runnerStarted({
        ts: 1_000,
        callId: 'planner-parent',
        role: 'planner',
        phase: 'planning',
        sequence: 1,
      }),
    );
    addEvent(
      runnerStarted({
        ts: 1_100,
        callId: 'native-injection',
        role: 'planner',
        phase: 'planning',
        sequence: 2,
      }),
    );

    expect(operationsStore.get().active).toMatchObject({
      callId: 'native-injection',
      status: 'running',
    });

    addEvent(
      runnerCompleted({
        ts: 1_150,
        callId: 'native-injection',
        role: 'planner',
        phase: 'planning',
        sequence: 3,
        startedAt: 1_100,
        endedAt: 1_150,
        durationMs: 50,
      }),
    );

    expect(operationsStore.get().active).toMatchObject({
      callId: 'planner-parent',
      status: 'running',
    });
    expect(operationsStore.get().last).toMatchObject({
      callId: 'native-injection',
      status: 'completed',
    });
  });

  it('closes a planner_status fallback operation on workflow_cancelled', () => {
    addEvent(makePlannerStatus({ ts: 1_000, phase: 'planning', status: 'running' }));
    expect(operationsStore.get().active).toMatchObject({
      phase: 'planning',
      status: 'running',
    });

    addEvent({ type: 'workflow_cancelled', ts: 1_250, phase: 'planning' });

    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      phase: 'planning',
      status: 'cancelled',
      endedAt: 1_250,
      durationMs: 250,
    });
  });

  it.each([
    ['task', 'implementing'],
    ['final', 'final-review'],
  ] as const)(
    'opens one %s review fallback with the recorded seat and no taskId',
    (scope, phase) => {
      addEvent({
        type: 'review_started',
        ts: 1_000,
        phase,
        scope,
        ...(scope === 'task' && { afterTaskId: 'T001' }),
        tool: 'codex',
        model: 'gpt-5',
        axes: ['high'],
      });

      expect(operationsStore.get().active).toMatchObject({
        role: 'review',
        phase,
        runnerName: 'codex',
        model: 'gpt-5',
        axes: ['high'],
        status: 'running',
        startedAt: 1_000,
      });
      expect(operationsStore.get().active).not.toHaveProperty('taskId');
      expect(
        [...operationsStore.get().byCallId.values()].filter((op) => op.status === 'running'),
      ).toHaveLength(1);
    },
  );

  it('closes the review fallback for a real call and restores it between the review calls', () => {
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'implementing',
      scope: 'task',
      afterTaskId: 'T001',
      tool: 'codex',
      model: 'gpt-5',
    });
    const fallback = operationsStore.get().active;
    expect(fallback).not.toBeNull();
    addEvent(runnerStarted({ ts: 1_100, role: 'review', taskId: undefined }));
    expect(operationsStore.get().byCallId.get(fallback?.callId ?? '')).toMatchObject({
      status: 'completed',
      endedAt: 1_100,
      durationMs: 100,
    });
    expect(operationsStore.get().active?.callId).toBe('call-1');
    addEvent(
      runnerCompleted({
        ts: 1_200,
        role: 'review',
        taskId: undefined,
        startedAt: 1_100,
        endedAt: 1_200,
        durationMs: 100,
      }),
    );
    expect(operationsStore.get().active).toMatchObject({
      callId: fallback?.callId,
      role: 'review',
      runnerName: 'codex',
      model: 'gpt-5',
      status: 'running',
      startedAt: 1_000,
    });
    addEvent({
      type: 'review_completed',
      ts: 1_300,
      phase: 'implementing',
      scope: 'task',
      afterTaskId: 'T001',
      tool: 'codex',
      model: 'gpt-5',
      verdict: 'pass',
      findings: { blocking: 0, minor: 0 },
      duration: 300,
    });
    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      role: 'review',
      status: 'completed',
      endedAt: 1_300,
    });
  });

  it('closes a review fallback on review_completed without completing the run', () => {
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
    });
    addEvent({
      type: 'review_completed',
      ts: 1_250,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
      verdict: 'no-verdict',
      duration: 250,
    });
    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      role: 'review',
      status: 'completed',
      durationMs: 250,
    });
  });

  it('uses the engine step for a verdict-only review and carries it into the verdict call', () => {
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'final-review',
      scope: 'final',
      tool: 'codex',
    });
    expect(operationsStore.get().active?.reviewStep).toBeUndefined();
    addEvent({ type: 'review_step', ts: 1_010, phase: 'final-review', step: 'verdict' });
    addEvent(
      runnerStarted({ ts: 1_100, phase: 'final-review', role: 'review', taskId: undefined }),
    );
    expect(operationsStore.get().active?.reviewStep).toBe('verdict');
    addEvent({ type: 'review_step', ts: 1_200, phase: 'final-review', step: 'choosing-checks' });
    expect(operationsStore.get().active?.reviewStep).toBe('choosing-checks');
    addEvent(
      runnerCompleted({ ts: 1_300, phase: 'final-review', role: 'review', taskId: undefined }),
    );
    expect(operationsStore.get().active?.reviewStep).toBe('choosing-checks');
  });

  it('starts the review clock with the step its label names', () => {
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'final-review',
      scope: 'final',
      tool: 'codex',
    });
    addEvent({ type: 'review_step', ts: 1_010, phase: 'final-review', step: 'choosing-checks' });
    addEvent(
      runnerStarted({ ts: 1_100, phase: 'final-review', role: 'review', taskId: undefined }),
    );
    addEvent(
      runnerCompleted({ ts: 12_000, phase: 'final-review', role: 'review', taskId: undefined }),
    );
    addEvent({
      type: 'review_checks',
      ts: 12_050,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [],
    });
    expect(operationsStore.get().active).toMatchObject({
      reviewStep: 'verdict',
      startedAt: 12_050,
    });

    addEvent({ type: 'review_step', ts: 12_060, phase: 'final-review', step: 'verdict' });
    expect(operationsStore.get().active).toMatchObject({
      reviewStep: 'verdict',
      startedAt: 12_050,
    });
  });

  it('keeps planner_status on the planner role and closes it on done', () => {
    addEvent(
      makePlannerStatus({
        ts: 1_000,
        phase: 'planning',
        status: 'running',
        tool: 'claude-code',
        model: 'claude-sonnet-5',
      }),
    );
    expect(operationsStore.get().active).toMatchObject({
      role: 'planner',
      runnerName: 'claude-code',
      model: 'claude-sonnet-5',
    });
    addEvent(makePlannerStatus({ ts: 1_250, phase: 'planning', status: 'done' }));
    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      role: 'planner',
      status: 'completed',
      durationMs: 250,
    });
  });

  it('does not start a planner_status fallback while waiting on review', () => {
    addEvent(makePlannerStatus({ ts: 1_000, phase: 'planning', status: 'running' }));
    expect(operationsStore.get().active).toMatchObject({
      phase: 'planning',
      status: 'running',
    });

    addEvent(makePlannerStatus({ ts: 1_200, phase: 'reviewing-spec', status: 'running' }));

    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      phase: 'planning',
      status: 'completed',
      endedAt: 1_200,
    });
  });

  it('closes stale planner_status fallbacks when a new phase fallback starts', () => {
    addEvent(makePlannerStatus({ ts: 1_000, phase: 'researching', status: 'running' }));
    addEvent(makePlannerStatus({ ts: 1_200, phase: 'planning', status: 'running' }));
    addEvent(runnerStarted({ ts: 1_400, phase: 'planning', role: 'planner', callId: 'call-2' }));
    addEvent(
      runnerCompleted({
        ts: 1_500,
        phase: 'planning',
        role: 'planner',
        callId: 'call-2',
        startedAt: 1_400,
        endedAt: 1_500,
        durationMs: 100,
      }),
    );

    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().byCallId.get('status-fallback:planner:researching')).toMatchObject(
      {
        status: 'completed',
      },
    );
    expect(operationsStore.get().byCallId.get('status-fallback:planner:planning')).toMatchObject({
      status: 'completed',
    });
  });

  it('keeps post-cancel aborted terminal events idempotent for a known callId', () => {
    addEvent(runnerStarted({ ts: 1_000 }));
    markCancellationRequested({ ts: 1_250 });

    expect(operationsStore.get().active).toBeNull();
    expect(operationsStore.get().last).toMatchObject({
      callId: 'call-1',
      status: 'cancelled',
      durationMs: 250,
    });

    addEvent(runnerAborted({ ts: 1_900, endedAt: 1_900, durationMs: 900 }));

    const operation = operationsStore.get().byCallId.get('call-1');
    expect(operationsStore.get().active).toBeNull();
    expect(operation).toMatchObject({
      callId: 'call-1',
      status: 'cancelled',
      endedAt: 1_250,
      durationMs: 250,
      reason: 'user_cancelled',
      partial: false,
    });
  });

  it('dedupes repeated warning text while a call is running', () => {
    addEvent(runnerStarted());
    addEvent(runnerWarning({ warning: { code: 'stderr', message: 'same warning' } }));
    addEvent(
      runnerWarning({
        ts: 1_150,
        sequence: 3,
        warning: { code: 'stderr', message: 'same warning' },
      }),
    );
    addEvent(
      runnerWarning({
        ts: 1_200,
        sequence: 4,
        warning: { code: 'stderr', message: 'second warning' },
      }),
    );

    expect(operationsStore.get().byCallId.get('call-1')?.warnings).toEqual([
      expect.objectContaining({
        count: 2,
        latestMessage: 'same warning',
        firstTs: 1_100,
        lastTs: 1_150,
      }),
      expect.objectContaining({
        count: 1,
        latestMessage: 'second warning',
      }),
    ]);
  });

  it('does not merge different warnings that reuse a caller-supplied fingerprint', () => {
    addEvent(runnerStarted());
    addEvent(
      runnerWarning({
        warning: {
          code: 'first_warning',
          source: 'provider',
          fingerprint: 'rw:shared',
          message: 'first warning',
        },
      }),
    );
    addEvent(
      runnerWarning({
        ts: 1_150,
        sequence: 3,
        warning: {
          code: 'second_warning',
          source: 'provider',
          fingerprint: 'rw:shared',
          message: 'second warning',
        },
      }),
    );

    expect(operationsStore.get().byCallId.get('call-1')?.warnings).toEqual([
      expect.objectContaining({
        code: 'first_warning',
        fingerprint: 'rw:shared',
        count: 1,
        latestMessage: 'first warning',
      }),
      expect.objectContaining({
        code: 'second_warning',
        fingerprint: 'rw:shared',
        count: 1,
        latestMessage: 'second warning',
      }),
    ]);
  });

  it('ignores late warnings for terminal operations', () => {
    addEvent(runnerStarted());
    markCancellationRequested({ ts: 1_250 });
    addEvent(runnerWarning({ ts: 1_300, sequence: 3 }));

    expect(operationsStore.get().byCallId.get('call-1')).toMatchObject({
      status: 'cancelled',
      warnings: [],
      reason: 'user_cancelled',
    });
  });

  it('caps completed operation history while preserving running calls', () => {
    for (let index = 0; index < MAX_COMPLETED_OPERATIONS + 5; index += 1) {
      const callId = `call-${index}`;
      const startedAt = 1_000 + index * 10;
      addEvent(runnerStarted({ ts: startedAt, callId, sequence: index * 2 + 1 }));
      addEvent(
        runnerCompleted({
          ts: startedAt + 5,
          callId,
          sequence: index * 2 + 2,
          startedAt,
          endedAt: startedAt + 5,
          durationMs: 5,
        }),
      );
    }

    addEvent(
      runnerStarted({
        ts: 5_000,
        callId: 'still-running',
        sequence: 10_000,
      }),
    );

    const state = operationsStore.get();
    expect(state.byCallId.size).toBe(MAX_COMPLETED_OPERATIONS + 1);
    expect(state.byCallId.has('call-0')).toBe(false);
    expect(state.byCallId.has(`call-${MAX_COMPLETED_OPERATIONS + 4}`)).toBe(true);
    expect(state.active).toMatchObject({ callId: 'still-running', status: 'running' });
    expect(state.last).toMatchObject({
      callId: `call-${MAX_COMPLETED_OPERATIONS + 4}`,
      status: 'completed',
    });
  });

  it('keeps late terminal events idempotent for a recent cancelled call after capping', () => {
    for (let index = 0; index < MAX_COMPLETED_OPERATIONS + 2; index += 1) {
      const callId = `old-call-${index}`;
      const startedAt = 1_000 + index * 10;
      addEvent(runnerStarted({ ts: startedAt, callId, sequence: index * 2 + 1 }));
      addEvent(
        runnerCompleted({
          ts: startedAt + 5,
          callId,
          sequence: index * 2 + 2,
          startedAt,
          endedAt: startedAt + 5,
          durationMs: 5,
        }),
      );
    }
    addEvent(runnerStarted({ ts: 5_000, callId: 'recent-call', sequence: 10_001 }));
    markCancellationRequested({ ts: 5_100 });

    addEvent(
      runnerAborted({
        ts: 5_200,
        callId: 'recent-call',
        sequence: 10_002,
        startedAt: 5_000,
        endedAt: 5_200,
        durationMs: 200,
      }),
    );

    expect(operationsStore.get().byCallId.get('recent-call')).toMatchObject({
      callId: 'recent-call',
      status: 'cancelled',
      endedAt: 5_100,
      durationMs: 100,
    });
  });

  it.each(runnerCallFailureStatuses)('preserves runner_call_error status %s', (status) => {
    addEvent(runnerStarted());
    addEvent(
      runnerAborted({
        status,
        error: { code: status, message: 'runner stopped' },
      }),
    );

    expect(operationsStore.get().last).toMatchObject({
      callId: 'call-1',
      status,
      reason: 'runner stopped',
      partial: true,
    });
    expect(operationsStore.get().byCallId.get('call-1')?.status).toBe(status);
  });

  it('sanitizes operation labels, runner metadata, warnings, and reasons', () => {
    addEvent(
      runnerStarted({
        runnerName: 'codex\u001b]0;owned\u0007 sk-abcdefghijklmnopqrst',
        model: 'xhigh\u001b[31m sk-ant-abcdefghijklmnopqrstuvwxyz',
      }),
    );
    addEvent(
      runnerWarning({
        warning: {
          code: 'stderr',
          message: 'warn\u001b[31mred\u001b[0m token sk-or-abcdefghijklmnopqrst',
        },
      }),
    );
    addEvent(
      runnerAborted({
        error: {
          code: 'aborted',
          message: 'cancelled\u001b]0;owned\u0007now token sk-abcdefghijklmnopqrst',
        },
      }),
    );

    const operation = operationsStore.get().byCallId.get('call-1');
    expect(operation).toMatchObject({
      label: 'implementer implementing (codex sk-***REDACTED*** xhigh sk-ant-***REDACTED***)',
      runnerName: 'codex sk-***REDACTED***',
      model: 'xhigh sk-ant-***REDACTED***',
      warnings: [
        expect.objectContaining({
          latestMessage: 'warnred token sk-or-***REDACTED***',
          count: 1,
        }),
      ],
      reason: 'cancellednow token sk-***REDACTED***',
    });
    expect(JSON.stringify(operation)).not.toContain('abcdefghijklmnopqrst');
  });

  it('stamps a running gate stage with the time it started and keeps it across progress events', () => {
    addEvent(
      makeValidate({
        ts: 5_000,
        status: 'running',
        activeStage: 'test',
        commands: { test: 'npm test' },
      }),
    );
    expect(operationsStore.get().validationStage).toEqual({
      stage: 'test',
      command: 'npm test',
      stageStartedTs: 5_000,
    });

    addEvent(
      makeValidate({
        ts: 9_000,
        status: 'running',
        activeStage: 'test',
        commands: { test: 'npm test' },
      }),
    );
    expect(operationsStore.get().validationStage?.stageStartedTs).toBe(5_000);

    addEvent(makeValidate({ ts: 12_000, status: 'done' }));
    expect(operationsStore.get().validationStage).toBeNull();
  });

  it('stamps an open full-suite stage and clears it when the stage settles', () => {
    addEvent({
      type: 'full_suite',
      ts: 5_000,
      phase: 'implementing',
      status: 'running',
      stage: 'test',
      command: 'npm test',
      moment: 'pre-review',
    });
    expect(operationsStore.get().suiteStage).toEqual({
      stage: 'test',
      command: 'npm test',
      moment: 'pre-review',
      stageStartedTs: 5_000,
    });

    addEvent({
      type: 'full_suite',
      ts: 12_000,
      phase: 'implementing',
      status: 'done',
      stage: 'test',
      command: 'npm test',
      moment: 'pre-review',
      passed: true,
      duration: 7_000,
    });
    expect(operationsStore.get().suiteStage).toBeNull();
  });

  it('keys a reviewer check by its id: the next check restarts the clock, its own settle clears it', () => {
    const check = (ts: number, id: string, status: 'running' | 'done') =>
      addEvent({
        type: 'full_suite',
        ts,
        phase: 'final-review',
        status,
        id,
        command: id === 'V1' ? 'npm run typecheck' : 'npm test',
        moment: 'pre-review',
        ...(status === 'done' && { passed: true, duration: 1_000 }),
      });

    check(5_000, 'V1', 'running');
    check(6_000, 'V1', 'running');
    expect(operationsStore.get().suiteStage).toEqual({
      id: 'V1',
      command: 'npm run typecheck',
      moment: 'pre-review',
      stageStartedTs: 5_000,
    });

    check(7_000, 'V2', 'running');
    expect(operationsStore.get().suiteStage).toEqual({
      id: 'V2',
      command: 'npm test',
      moment: 'pre-review',
      stageStartedTs: 7_000,
    });

    check(9_000, 'V2', 'done');
    expect(operationsStore.get().suiteStage).toBeNull();
  });

  it('keys a reviewer check by its moment too: its base re-run restarts the clock', () => {
    const check = (ts: number, moment: 'pre-review' | 'base') =>
      addEvent({
        type: 'full_suite',
        ts,
        phase: 'final-review',
        status: 'running',
        id: 'V1',
        command: 'npm test',
        moment,
      });

    check(5_000, 'pre-review');
    check(9_000, 'base');
    expect(operationsStore.get().suiteStage).toEqual({
      id: 'V1',
      command: 'npm test',
      moment: 'base',
      stageStartedTs: 9_000,
    });
  });

  it.each(['workflow_cancelled', 'turn_interrupted'] as const)(
    '%s clears command stages and a resumed command starts a new clock',
    (type) => {
      const suiteRunning = (ts: number) =>
        addEvent({
          type: 'full_suite',
          ts,
          phase: 'implementing',
          status: 'running',
          stage: 'test',
          command: 'npm test',
          moment: 'pre-review',
        });
      const gateRunning = (ts: number) =>
        addEvent(
          makeValidate({
            ts,
            status: 'running',
            activeStage: 'lint',
            commands: { lint: 'npm run lint' },
          }),
        );
      suiteRunning(5_000);
      gateRunning(5_000);

      addEvent({ type, ts: 8_000, phase: 'implementing' });
      expect(operationsStore.get().suiteStage).toBeNull();
      expect(operationsStore.get().validationStage).toBeNull();

      hydrateFromState(makeWorkflowState({ phase: 'implementing' }));
      addEvent({ type: 'workflow_resumed', ts: 600_000, phase: 'implementing' });
      suiteRunning(600_000);
      gateRunning(600_000);
      expect(operationsStore.get().suiteStage?.stageStartedTs).toBe(600_000);
      expect(operationsStore.get().validationStage?.stageStartedTs).toBe(600_000);
    },
  );

  it('retains the scenario and clock of a plan render until stopped settles it', () => {
    const render = {
      type: 'full_suite',
      ts: 5_000,
      phase: 'final-review',
      id: 'R1',
      moment: 'plan',
      scenario: 'workflow-x',
      command: 'npm run tui-shots -- --scenario workflow-x',
      status: 'running',
    } satisfies EngineEventOf<'full_suite'>;
    addEvent(render);
    expect(operationsStore.get().suiteStage).toMatchObject({
      moment: 'plan',
      scenario: 'workflow-x',
      stageStartedTs: 5_000,
    });
    addEvent({ ...render, ts: 8_000, status: 'stopped' });
    expect(operationsStore.get().suiteStage).toBeNull();
  });

  it('runs a brief plan check on its own clock from its start until the brief records its checks', () => {
    const base = {
      type: 'task_validating',
      phase: 'validating-task',
      taskId: taskId('T001'),
    } as const;
    addEvent({ ...base, ts: 1_000 });
    expect(operationsStore.get().suiteStage ?? null).toBeNull();
    addEvent({ ...base, ts: 2_000, check: { id: 'K1', command: 'npm run lint' } });
    addEvent({ ...base, ts: 9_000, check: { id: 'K2', command: 'npm test' } });
    expect(operationsStore.get().suiteStage).toEqual({
      id: 'K2',
      command: 'npm test',
      moment: 'plan',
      stageStartedTs: 9_000,
    });
    addEvent({
      type: 'checks_run',
      ts: 15_000,
      phase: 'validating-task',
      taskId: taskId('T001'),
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'pass' },
      ],
    });
    expect(operationsStore.get().suiteStage).toBeNull();
  });
});
