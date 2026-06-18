import { beforeEach, describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { addEvent, markCancellationRequested, resetWorkflow } from './actions.js';
import { operationsStore } from './operations.js';
import { makePlannerStatus } from '#testing/helpers/events.js';

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
      partial: true,
    });
  });

  it('sanitizes operation labels, tool metadata, warnings, and reasons', () => {
    addEvent(
      runnerStarted({
        runnerName: 'codex\u001b]0;owned\u0007 sk-abcdefghijklmnopqrst',
        model: 'xhigh\u001b[31m sk-ant-abcdefghijklmnopqrstuvwxyz',
      }),
    );
    addEvent({
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
        message: 'warn\u001b[31mred\u001b[0m token sk-or-abcdefghijklmnopqrst',
      },
    });
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
