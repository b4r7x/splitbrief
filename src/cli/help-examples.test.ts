import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from './help-examples.js';

describe('HELP_EXAMPLES', () => {
  it('shows how to select a mode for a planning-only run', () => {
    const modesBlock = HELP_EXAMPLES.split('Workflow modes:')[1] ?? '';
    expect(modesBlock).toContain('splitbrief spec "planning only" --mode quick');
    expect(modesBlock).toContain('--mode');
  });
});
