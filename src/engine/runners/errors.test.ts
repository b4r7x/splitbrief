import { describe, expect, expectTypeOf, test } from 'vitest';
import type { RunnerCallResult, RunnerCallStatus } from '../calls/types.js';
import { runnerCallOutcome } from '../implementers/pipeline/call-result.js';
import {
  RUNNER_OUTCOME_STATES,
  runnerConfigError,
  runnerOutcome,
  type RunnerOutcomeState,
} from './errors.js';

function callResult(status: RunnerCallStatus, code = 'provider-error'): RunnerCallResult {
  const common = {
    callId: 'call-1',
    role: 'implementer',
    backendKind: 'cli',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  } satisfies Omit<RunnerCallResult, 'status' | 'error' | 'partial'>;

  if (status === 'completed') {
    return { ...common, status, error: null, partial: false };
  }
  return { ...common, status, error: { code, message: 'provider failed' }, partial: true };
}

describe('runnerConfigError factories', () => {
  test('missingToolConfig formats planner vs implementer differently', () => {
    const planner = runnerConfigError.missingToolConfig('claude-code', 'planner');
    expect(planner.message).toBe("CLI tool 'claude-code' has no planner configuration");
    expect(planner.data).toEqual({ toolName: 'claude-code', role: 'planner' });

    const implementer = runnerConfigError.missingToolConfig('aider', 'implementer');
    expect(implementer.message).toBe("CLI tool 'aider' has no implementer configuration");
    expect(implementer.data).toEqual({ toolName: 'aider', role: 'implementer' });
  });
});

describe('runner outcome taxonomy', () => {
  test('keeps every machine state distinct and rejects states outside the closed union', () => {
    expect(RUNNER_OUTCOME_STATES).toEqual([
      'spawn-not-found',
      'incompatible-version',
      'unauthenticated',
      'usage-limit',
      'timeout',
      'user-abort',
      'signal-exit',
      'non-zero-exit',
      'protocol-failure',
      'output-budget-breach',
      'callback-failure',
      'no-staged-change',
      'platform-limitation',
      'success',
    ]);
    expectTypeOf<RunnerOutcomeState>().toEqualTypeOf<(typeof RUNNER_OUTCOME_STATES)[number]>();

    // @ts-expect-error An unmapped state must not enter the machine contract.
    const unmapped: RunnerOutcomeState = 'new-unmapped-state';
    expect(unmapped).toBe('new-unmapped-state');
  });

  test('gives every failure bounded remediation and success no remediation', () => {
    const failureStates = RUNNER_OUTCOME_STATES.filter((state) => state !== 'success');
    for (const state of failureStates) {
      const outcome = runnerOutcome.failure(state);
      expect(outcome).toMatchObject({ state });
      expect(outcome.remediation).toEqual(expect.any(String));
      expect(outcome.remediation.length).toBeGreaterThan(0);
      expect(outcome.remediation.length).toBeLessThanOrEqual(4_000);
    }

    const bounded = runnerOutcome.failure(
      'protocol-failure',
      `API_KEY=sk-very-secret-value-1234567890 ${'x'.repeat(5_000)}`,
    );
    expect(bounded.remediation).not.toContain('sk-very-secret-value-1234567890');
    expect(bounded.remediation.length).toBeLessThanOrEqual(4_000);
    expect(runnerOutcome.success()).toEqual({ state: 'success', remediation: null });
  });

  test('projects stable error codes and legacy call statuses without collapsing outcomes', () => {
    for (const state of RUNNER_OUTCOME_STATES) {
      if (state === 'success') continue;
      expect(runnerCallOutcome(callResult('failed', state)).state).toBe(state);
    }

    expect(runnerCallOutcome(callResult('completed')).state).toBe('success');
    expect(runnerCallOutcome(callResult('truncated')).state).toBe('output-budget-breach');
    expect(runnerCallOutcome(callResult('aborted')).state).toBe('user-abort');
    expect(runnerCallOutcome(callResult('timeout')).state).toBe('timeout');
    expect(runnerCallOutcome(callResult('unsupported_tool')).state).toBe('platform-limitation');
    expect(runnerCallOutcome(callResult('incomplete')).state).toBe('protocol-failure');
  });
});
