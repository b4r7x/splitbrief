import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_RETRIES } from './retries.js';

describe('DEFAULT_LOCAL_RETRIES', () => {
  it('is two local attempts before the ladder escalates', () => {
    expect(DEFAULT_LOCAL_RETRIES).toBe(2);
  });
});
