import { describe, expect, it } from 'vitest';
import { TokenUsageSchema, totalInputTokens, totalOutputTokens } from './tokens.js';

const legacyUsage = {
  plannerInput: 10,
  plannerOutput: 20,
  implementerInput: 30,
  implementerOutput: 40,
  escalationInput: 50,
  escalationOutput: 60,
};

describe('TokenUsageSchema', () => {
  it('defaults reviewer usage when parsing session state written before reviewer accounting', () => {
    expect(TokenUsageSchema.parse(legacyUsage)).toEqual({
      ...legacyUsage,
      reviewerInput: 0,
      reviewerOutput: 0,
    });
  });

  it('includes reviewer usage in aggregate token totals', () => {
    const usage = TokenUsageSchema.parse({
      ...legacyUsage,
      reviewerInput: 70,
      reviewerOutput: 80,
    });

    expect(totalInputTokens(usage)).toBe(160);
    expect(totalOutputTokens(usage)).toBe(200);
  });
});
