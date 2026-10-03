import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from './help-examples.js';

describe('HELP_EXAMPLES', () => {
  it('shows a planning-only run without a mode', () => {
    const block = HELP_EXAMPLES.split('Planning only:')[1] ?? '';
    expect(block).toContain('splitbrief spec "add caching layer"');
    expect(HELP_EXAMPLES).not.toMatch(/--mode\b/);
    expect(HELP_EXAMPLES).not.toMatch(/--approve\b/);
  });
});
