import { describe, expect, it } from 'vitest';
import { retryExhaustedCause } from './causes.js';

describe('retryExhaustedCause', () => {
  it('falls back to exhausted retries when neither fact is present', () => {
    expect(retryExhaustedCause({ task: 'T005' })).toBe('T005 failed');
  });
});
