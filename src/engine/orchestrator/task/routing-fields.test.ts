import { describe, expect, it } from 'vitest';
import { buildRoutingEventFields, type RoutingEventFields } from './routing-fields.js';

function routingFields(overrides: Partial<RoutingEventFields> = {}): RoutingEventFields {
  return {
    fit: 'tight',
    estimatedTokens: 24_310,
    untruncatedEstimatedTokens: 24_310,
    contextLength: 32_768,
    usedConservativeContextLength: false,
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
    ...overrides,
  };
}

describe('buildRoutingEventFields', () => {
  it('keeps a known window', () => {
    expect(buildRoutingEventFields(routingFields())).toEqual({
      contextFit: 'tight',
      estimatedTokens: 24_310,
      untruncatedEstimatedTokens: 24_310,
      contextLength: 32_768,
      currentCodeTruncated: false,
      currentCodeContextMode: 'whole-file',
      routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
    });
  });

  it('leaves the window out of the event when it is a guess', () => {
    const reason =
      'Selected profile default (tight, estimated 6412/8192 tokens using conservative context-length fallback)';
    const fields = buildRoutingEventFields(
      routingFields({
        estimatedTokens: 6_412,
        untruncatedEstimatedTokens: 6_412,
        contextLength: 8_192,
        usedConservativeContextLength: true,
        reason,
      }),
    );

    expect(fields).not.toHaveProperty('contextLength');
    expect(fields).toEqual({
      contextFit: 'tight',
      estimatedTokens: 6_412,
      untruncatedEstimatedTokens: 6_412,
      currentCodeTruncated: false,
      currentCodeContextMode: 'whole-file',
      routingReason: reason,
    });
  });

  it('emits no field for a brief that routed nothing', () => {
    expect(buildRoutingEventFields(undefined)).toEqual({});
  });
});
