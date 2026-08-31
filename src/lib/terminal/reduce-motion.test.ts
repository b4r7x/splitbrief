import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from './reduce-motion.js';

describe('prefersReducedMotion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false when neither environment variable is set', () => {
    vi.stubEnv('SPLITBRIEF_REDUCE_MOTION', undefined);
    vi.stubEnv('REDUCE_MOTION', undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('returns true when SPLITBRIEF_REDUCE_MOTION is 1', () => {
    vi.stubEnv('SPLITBRIEF_REDUCE_MOTION', '1');
    vi.stubEnv('REDUCE_MOTION', undefined);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns true when REDUCE_MOTION is 1', () => {
    vi.stubEnv('SPLITBRIEF_REDUCE_MOTION', undefined);
    vi.stubEnv('REDUCE_MOTION', '1');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('returns false when set to other values', () => {
    vi.stubEnv('SPLITBRIEF_REDUCE_MOTION', '0');
    vi.stubEnv('REDUCE_MOTION', 'false');
    expect(prefersReducedMotion()).toBe(false);
  });
});
