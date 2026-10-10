import { describe, expect, it } from 'vitest';
import { toInvokeResult } from './projection.js';
import type { RunnerCallResult } from './types.js';

const result: RunnerCallResult = {
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'shell',
  status: 'completed',
  startedAt: 1,
  endedAt: 9,
  durationMs: 8,
  text: 'done',
  usage: { inputTokens: 1, outputTokens: 2 },
  nativeSessionId: null,
  toolUses: [],
  artifacts: [],
  warnings: [],
  error: null,
  partial: false,
};

describe('toInvokeResult', () => {
  it('projects completed call results to legacy InvokeResult', () => {
    expect(toInvokeResult(result)).toEqual({
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('preserves reasoning-token metadata in legacy InvokeResult projections', () => {
    expect(
      toInvokeResult({
        ...result,
        usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
      }),
    ).toEqual({
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
    });
  });

  it('rejects non-completed call results', () => {
    expect(() =>
      toInvokeResult({
        ...result,
        status: 'timeout',
        error: { code: 'timeout', message: 'runner timed out' },
        partial: true,
      }),
    ).toThrow(/Cannot project timeout/);
  });
});
