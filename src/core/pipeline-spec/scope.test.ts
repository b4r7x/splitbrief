import { describe, expect, it } from 'vitest';
import { SCOPE_RULE } from './scope.js';

describe('scope spec', () => {
  it('names the declared set, the in-bounds paths and the done briefs as guidance', () => {
    expect(SCOPE_RULE.allowedSetText).toContain('**In bounds**');
    expect(SCOPE_RULE.allowedSetText).toContain('**Approved out of bounds**');
    expect(SCOPE_RULE.allowedSetText).toContain('already `done`');
    expect(SCOPE_RULE.allowedSetText).toContain('guidance');
  });

  it('records an unplanned path and never fails the attempt on it', () => {
    expect(SCOPE_RULE.driftText).toContain('recorded for the reviewer');
    expect(SCOPE_RULE.driftText).not.toContain('fails the attempt;');
    expect(SCOPE_RULE.driftText).not.toMatch(/revert/i);
  });

  it('has no revert instruction', () => {
    expect('revertInstruction' in SCOPE_RULE).toBe(false);
  });
});
