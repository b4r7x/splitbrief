import { describe, it, expect } from 'vitest';
import { clampToMaxOutput, DEFAULT_MAX_OUTPUT_TOKENS } from './capability-inference.js';

describe('clampToMaxOutput', () => {
  it('clamps to the per-model output cap when known', () => {
    expect(clampToMaxOutput(1_000_000, 8192)).toBe(8192);
  });

  it('passes through a value already under the cap', () => {
    expect(clampToMaxOutput(4096, 8192)).toBe(4096);
  });

  it('falls back to the conservative default when the cap is unknown', () => {
    expect(clampToMaxOutput(1_000_000)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});
