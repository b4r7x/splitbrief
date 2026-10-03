import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_RETRIES } from './retries.js';

describe('DEFAULT_LOCAL_RETRIES', () => {
  it('is one local attempt before the ladder consults the planner', () => {
    expect(DEFAULT_LOCAL_RETRIES).toBe(1);
  });
});
