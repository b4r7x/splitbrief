import { describe, it, expect } from 'vitest';
import { fenced } from './builder.js';

describe('fenced', () => {
  it('uses a three-backtick fence with the language tag for ordinary content', () => {
    expect(fenced('+added line', 'diff')).toBe('```diff\n+added line\n```');
  });

  it('outruns a fence the body carries, so no content line closes the block', () => {
    const diff = ' ```\n+code\n ```';

    const block = fenced(diff, 'diff');

    expect(block.startsWith('````diff\n')).toBe(true);
    expect(block.endsWith('\n````')).toBe(true);
    expect(block).toContain(diff);
  });

  it('outruns the longest run anywhere in the body', () => {
    const block = fenced('`one` and `````five`````');

    expect(block.startsWith('``````\n')).toBe(true);
    expect(block.endsWith('\n``````')).toBe(true);
  });
});
