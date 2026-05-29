import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from './help-examples.js';

describe('HELP_EXAMPLES', () => {
  it('covers the supported invocation forms users need most often', () => {
    const exampleLines = HELP_EXAMPLES.split('\n').filter((line) =>
      line.trim().startsWith('$ diptych'),
    );
    expect(exampleLines.length).toBeGreaterThanOrEqual(10);

    for (const snippet of [
      '$ diptych "',
      '$ diptych start "',
      '@design.md',
      '@screenshot.png',
      '--mode instant',
      '--mode quick',
      '--mode speckit',
      '--worktree',
      '--detach',
      '--json',
      'diptych status',
      'diptych resume',
      'diptych doctor',
    ]) {
      expect(HELP_EXAMPLES).toContain(snippet);
    }
  });
});
