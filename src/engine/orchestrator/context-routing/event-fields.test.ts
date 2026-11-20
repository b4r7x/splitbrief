import { describe, expect, it } from 'vitest';
import { buildRoutingEventFields, type RoutingEventFields } from './event-fields.js';

function routingFields(overrides: Partial<RoutingEventFields> = {}): RoutingEventFields {
  return {
    fit: 'tight',
    currentCodeTruncated: false,
    currentCodeContextMode: 'whole-file',
    reason: 'Selected profile default (tight)',
    ...overrides,
  };
}

describe('buildRoutingEventFields', () => {
  it('keeps the fit and routing reason', () => {
    expect(buildRoutingEventFields(routingFields())).toEqual({
      contextFit: 'tight',
      currentCodeTruncated: false,
      currentCodeContextMode: 'whole-file',
      routingReason: 'Selected profile default (tight)',
    });
  });

  it('keeps the routing reason for a fallback window', () => {
    const reason = 'Selected a profile with the fallback context window';
    const fields = buildRoutingEventFields(
      routingFields({
        reason,
      }),
    );

    expect(fields).not.toHaveProperty('contextLength');
    expect(fields).toEqual({
      contextFit: 'tight',
      currentCodeTruncated: false,
      currentCodeContextMode: 'whole-file',
      routingReason: reason,
    });
  });

  it('emits no field for a brief that routed nothing', () => {
    expect(buildRoutingEventFields(undefined)).toEqual({});
  });
});
