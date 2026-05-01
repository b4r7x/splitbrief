import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from './help-examples.js';

describe('HELP_EXAMPLES', () => {
  it('contains at least 10 example invocations', () => {
    const exampleLines = HELP_EXAMPLES.split('\n').filter(line => line.trim().startsWith('$ diptych'));
    expect(exampleLines.length).toBeGreaterThanOrEqual(10);
  });

  it('includes shorthand form (no start subcommand)', () => {
    expect(HELP_EXAMPLES).toContain('$ diptych "');
  });

  it('includes @file syntax examples', () => {
    expect(HELP_EXAMPLES).toContain('@design.md');
    expect(HELP_EXAMPLES).toContain('@screenshot.png');
  });

  it('includes explicit start form', () => {
    expect(HELP_EXAMPLES).toContain('$ diptych start "');
  });

  it('includes all workflow modes', () => {
    expect(HELP_EXAMPLES).toContain('--mode instant');
    expect(HELP_EXAMPLES).toContain('--mode quick');
    expect(HELP_EXAMPLES).toContain('--mode speckit');
  });

  it('includes worktree examples', () => {
    expect(HELP_EXAMPLES).toContain('--worktree');
  });

  it('includes detach and json examples', () => {
    expect(HELP_EXAMPLES).toContain('--detach');
    expect(HELP_EXAMPLES).toContain('--json');
  });

  it('includes other common commands', () => {
    expect(HELP_EXAMPLES).toContain('diptych status');
    expect(HELP_EXAMPLES).toContain('diptych resume');
    expect(HELP_EXAMPLES).toContain('diptych doctor');
  });
});
