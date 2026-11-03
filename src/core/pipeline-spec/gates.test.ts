import { describe, expect, it } from 'vitest';
import { NARROWING_KINDS } from '../validation/stacks/types.js';
import { CAPTURE_LIMITS, NARROWING_RULE } from './gates.js';

describe('CAPTURE_LIMITS', () => {
  it('caps captured output and the test tail', () => {
    expect(CAPTURE_LIMITS).toEqual({ outputChars: 4096, testTailLines: 40 });
  });
});

describe('NARROWING_RULE', () => {
  it('names every narrowing kind', () => {
    expect(NARROWING_RULE.kinds).toEqual(NARROWING_KINDS);
    expect(NARROWING_RULE.text).toContain('stack default');
    expect(NARROWING_RULE.text).toContain('`test` check');
  });
});
