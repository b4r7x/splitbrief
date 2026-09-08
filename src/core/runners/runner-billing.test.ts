import { describe, expect, it } from 'vitest';
import { RUNNER_BILLING_POSTURES, billingWord } from './runner-billing.js';

describe('runner billing posture', () => {
  it('lists the billing postures in canonical presentation order', () => {
    expect(RUNNER_BILLING_POSTURES).toEqual([
      'local',
      'subscription-included',
      'api-metered',
      'provider-dependent',
      'unknown',
    ]);
  });
});

describe('billingWord', () => {
  it('returns one word per resolved posture', () => {
    expect(billingWord('local')).toBe('local');
    expect(billingWord('subscription-included')).toBe('subscription');
    expect(billingWord('api-metered')).toBe('metered');
    expect(billingWord('provider-dependent')).toBe('provider');
  });

  it('gives an unresolved posture no word', () => {
    expect(billingWord('unknown')).toBeUndefined();
  });

  it('yields a non-empty lowercase token for every resolved posture', () => {
    for (const posture of RUNNER_BILLING_POSTURES) {
      if (posture === 'unknown') continue;
      const word = billingWord(posture);
      expect(word).toBeTypeOf('string');
      expect(word).not.toBe('');
      expect(word).toBe(word?.toLowerCase());
    }
  });
});
