import { describe, expect, it } from 'vitest';
import { CURSOR_CLI_CANDIDATE } from '../../../core/runners/cli-tool-catalog.js';

describe('Cursor candidate', () => {
  it('retains ordered executable resolution metadata without an execution contract', () => {
    expect(CURSOR_CLI_CANDIDATE).toEqual({
      id: 'cursor',
      displayName: 'Cursor Agent CLI',
      command: 'agent',
      executableAliases: ['agent', 'cursor-agent'],
      category: 'cli',
      admission: {
        state: 'not-admitted',
        prerequisite: 'R7-008',
        remediation:
          'Cursor Agent CLI is unavailable until R7-008 verifies an exact build-pinned protocol and a fresh filtered workspace.',
      },
    });
  });
});
