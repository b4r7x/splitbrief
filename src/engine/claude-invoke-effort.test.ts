import { describe, it, expect } from 'vitest';
import { applyEffortPrefix } from './claude-invoke.js';

describe('applyEffortPrefix', () => {
  it('returns prompt unchanged when effort is undefined', () => {
    expect(applyEffortPrefix('hello', undefined)).toBe('hello');
  });
  it('prepends /effort directive when effort is set', () => {
    expect(applyEffortPrefix('hello', 'high')).toBe('/effort high\n\nhello');
  });
  it('handles empty prompt', () => {
    expect(applyEffortPrefix('', 'medium')).toBe('/effort medium\n\n');
  });
});
