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

  it('accepts module hooks but rejects mixed command/module entries', () => {
    expect(HookEntrySchema.safeParse({ kind: 'module', path: './hooks/pre-task.js' }).success).toBe(true);
    expect(HookEntrySchema.safeParse({ kind: 'module', path: './hooks/pre-task.js', command: 'echo ok' }).success).toBe(false);
    expect(HookEntrySchema.safeParse({ kind: 'command', command: './scripts/pre-task.sh', path: './hooks/pre-task.js' }).success).toBe(false);
  });

  it.each([
    [{ command: 'sh' }],
    [{ command: '/bin/bash' }],
    [{ command: './scripts/pre-task.sh', timeout_ms: 999_999 }],
  ])('rejects unsafe hook config %o', (entry) => {
    expect(HookEntrySchema.safeParse(entry).success).toBe(false);
  });
});
