import { describe, expect, it } from 'vitest';
import { applyInvokeResultProjection, toInvokeResult } from './projection.js';
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

  it('applies legacy postprocess output without dropping collected call values', () => {
    const projected = applyInvokeResultProjection(
      {
        ...result,
        toolUses: [
          {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/app.ts' },
            output: null,
          },
        ],
      },
      {
        text: 'planned',
        usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
        sessionId: 'native-1',
      },
    );

    expect(projected).toMatchObject({
      text: 'planned',
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
      nativeSessionId: 'native-1',
      toolUses: [{ id: 'tool-1', name: 'Read' }],
    });
  });
});
