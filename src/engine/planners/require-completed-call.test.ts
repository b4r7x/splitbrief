import { describe, it, expect } from 'vitest';
import { requireCompletedCall } from './require-completed-call.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';

describe('requireCompletedCall', () => {
  it('returns the result when status is completed', () => {
    const result = makeRunnerCallResult({ status: 'completed', text: 'ok' });
    expect(requireCompletedCall(result)).toBe(result);
  });

  it('throws runner-call-failed when status is not completed', () => {
    const result = makeRunnerCallResult({
      status: 'failed',
      text: '',
      error: { code: 'test_failure', message: 'runner failed' },
      role: 'planner',
    });
    expect(() => requireCompletedCall(result)).toThrow(
      expect.objectContaining({
        kind: 'runner-call-failed',
        message: 'Planner planner call failed',
        data: expect.objectContaining({
          callId: result.callId,
          role: 'planner',
          status: 'failed',
        }),
      }),
    );
  });
});
