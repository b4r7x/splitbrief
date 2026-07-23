import { describe, it, expect } from 'vitest';
import { HookEntrySchema } from './hooks.js';

describe('HookEntrySchema', () => {
  it('parses legacy command hook entries with runtime defaults', () => {
    const result = HookEntrySchema.parse({ command: './scripts/pre-task.sh' });

    expect(result).toEqual({
      kind: 'command',
      command: './scripts/pre-task.sh',
      args: [],
      timeout_ms: 30_000,
      on_failure: 'warn',
    });
  });

  it.each([
    [{ command: 'sh' }],
    [{ command: '/bin/bash' }],
    [{ command: 'zsh' }],
    [{ command: 'pwsh' }],
    [{ command: 'cmd.exe' }],
    [{ command: '/usr/bin/env' }],
    [{ command: 'node', args: ['-c', 'echo nope'] }],
    [{ command: 'node', args: ['bash'] }],
    [{ command: './scripts/pre-task.sh', timeout_ms: 999_999 }],
  ])('rejects unsafe hook config %o', (entry) => {
    expect(HookEntrySchema.safeParse(entry).success).toBe(false);
  });
});
