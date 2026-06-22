import { beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import {
  protectEngineEventForConsumer,
  TRANSCRIPT_OMITTED_MESSAGE,
} from '../../engine/events/protection.js';
import type { RunnerCallWarningInput } from '../../engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../engine/calls/warnings.js';
import { addEvent, markCancellationRequested, resetWorkflow } from './actions.js';
import { MAX_COMPLETED_OPERATIONS, operationsStore } from './operations.js';
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

  it('groups transcript-off warnings by safe metadata without hidden message fingerprints', () => {
    addEvent(runnerStarted());
    const first = protectedRunnerWarning(
      runnerWarning({
        warning: {
          code: 'provider_retry',
          source: 'provider',
          surface: 'status',
          message: 'hidden retry detail one',
        },
      }),
    );
    const second = protectedRunnerWarning(
      runnerWarning({
        ts: 1_150,
        sequence: 3,
        warning: {
          code: 'provider_retry',
          source: 'provider',
          surface: 'status',
          message: 'hidden retry detail two',
        },
      }),
    );

    addEvent(first);
    addEvent(second);

    expect(operationsStore.get().byCallId.get('call-1')?.warnings).toEqual([
      expect.objectContaining({
        code: 'provider_retry',
        fingerprint: expect.stringMatching(/^rw-safe:/),
        count: 2,
        latestMessage: TRANSCRIPT_OMITTED_MESSAGE,
      }),
    ]);
    expect(JSON.stringify(operationsStore.get().byCallId.get('call-1')?.warnings)).not.toContain(
      'hidden retry detail',
    );
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
});

function protectedRunnerWarning(
  event: EngineEventOf<'runner_call_warning'>,
): EngineEventOf<'runner_call_warning'> {
  const protectedEvent = protectEngineEventForConsumer(event, {
    context: 'ipc',
    persistTranscript: false,
  });
  if (protectedEvent?.type !== 'runner_call_warning') {
    throw new Error('Expected protected runner_call_warning event');
  }
  return protectedEvent;
}
