import { describe, expect, it } from 'vitest';
import { SCOPE_RULE } from './scope.js';

describe('scope spec', () => {
  it('names the declared set, the in-bounds paths and the done briefs', () => {
    expect(SCOPE_RULE.allowedSetText).toContain('**In bounds**');
    expect(SCOPE_RULE.allowedSetText).toContain('**Approved out of bounds**');
    expect(SCOPE_RULE.allowedSetText).toContain('already `done`');
  });

  it('fails the attempt on any path left after the allowed set', () => {
    expect(SCOPE_RULE.driftText).toContain('fails the attempt');
  });

  it('renders the revert instruction for the undeclared paths', () => {
    expect(SCOPE_RULE.revertInstruction(['src/b.ts'], ['src/a.ts'])).toBe(
      'Revert your changes to src/b.ts; only src/a.ts may change',
    );
  });

  it('joins several paths and several declared files with commas', () => {
    expect(
      SCOPE_RULE.revertInstruction(['src/b.ts', 'src/c.ts'], ['src/a.ts', 'src/a.test.ts']),
    ).toBe('Revert your changes to src/b.ts, src/c.ts; only src/a.ts, src/a.test.ts may change');
  });
});
