import { beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { addEvent, markCancellationRequested, resetWorkflow } from './actions.js';
import { operationsStore } from './operations.js';
import { makePlannerStatus } from '#testing/helpers/events.js';

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
  overrides?: Partial<EngineEventOf<'runner_call_warning'>>,
): EngineEventOf<'runner_call_warning'> {
  return {
    type: 'runner_call_warning',
    ts: 1_100,
    phase: 'implementing',
    taskId: taskId('T001'),
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 2,
    warning: {
      code: 'stderr',
      message: 'warn',
    },
    ...overrides,
  };
}

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
    expect(operationsStore.get().byCallId.get('planner-status:researching')).toMatchObject({
      status: 'completed',
    });
    expect(operationsStore.get().byCallId.get('planner-status:planning')).toMatchObject({
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
      'same warning',
      'second warning',
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
      warnings: ['warnred token sk-or-***REDACTED***'],
      reason: 'cancellednow token sk-***REDACTED***',
    });
    expect(JSON.stringify(operation)).not.toContain('abcdefghijklmnopqrst');
  });
});
