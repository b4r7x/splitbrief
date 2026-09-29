import { describe, it, expect } from 'vitest';
import { requireCompletedCall } from './require-completed-call.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { RunnerCallWarning } from '../calls/types.js';

// Captured live from `agy -p` on 2026-09-21: the first limit hit exits 0.
const AGY_LIMIT =
  'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s. (response may be truncated)';

function stderrWarning(message: string): RunnerCallWarning {
  return {
    code: 'stderr_diagnostic',
    severity: 'warning',
    source: 'stderr',
    surface: 'status',
    channel: 'stderr',
    fingerprint: 'stderr-diagnostic',
    message,
  };
}

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

  it('fails a call that completed with no text after a usage limit on stderr', () => {
    const result = makeRunnerCallResult({
      status: 'completed',
      text: '\n',
      role: 'escalation',
      warnings: [stderrWarning(AGY_LIMIT)],
    });

    expect(() => requireCompletedCall(result)).toThrow(
      expect.objectContaining({
        kind: 'runner-call-failed',
        message: 'Planner escalation call failed',
        data: expect.objectContaining({
          status: 'failed',
          error: { code: 'usage-limit', message: AGY_LIMIT },
        }),
      }),
    );
  });

  it('returns a completed call whose text stands, or whose stderr names no limit', () => {
    const answered = makeRunnerCallResult({
      status: 'completed',
      text: 'use a default',
      warnings: [stderrWarning(AGY_LIMIT)],
    });
    const silent = makeRunnerCallResult({
      status: 'completed',
      text: '',
      warnings: [stderrWarning('warning: config key "model" is deprecated')],
    });

    expect(requireCompletedCall(answered)).toBe(answered);
    expect(requireCompletedCall(silent)).toBe(silent);
  });

  it('returns a call that wrote its artifact, whatever its stderr said', () => {
    const wrote = makeRunnerCallResult({
      status: 'completed',
      text: '',
      warnings: [stderrWarning(AGY_LIMIT)],
      artifacts: [
        {
          id: 'artifact-spec',
          source: 'file',
          name: 'spec.md',
          path: 'spec.md',
          mimeType: 'text/markdown',
          text: '# Spec',
        },
      ],
    });

    expect(requireCompletedCall(wrote)).toBe(wrote);
  });
});
