import { describe, expect, it } from 'vitest';
import { RUNNER_BILLING_POSTURES } from './runner-billing.js';

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
