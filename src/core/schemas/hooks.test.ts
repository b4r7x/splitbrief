import { describe, it, expect } from 'vitest';
import { HookEntrySchema, HooksConfigSchema } from './hooks.js';

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

describe('HooksConfigSchema retired commit events', () => {
  const preTask = [{ command: './scripts/pre-task.sh' }];

  it.each(['pre_commit', 'post_commit'])(
    'rejects a populated %s list at its own path with a removal message',
    (event) => {
      const result = HooksConfigSchema.safeParse({
        pre_task: preTask,
        [event]: [{ command: './scripts/commit.sh' }],
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          path: [event],
          message: expect.stringContaining(`delete hooks.${event}`),
        }),
      ]);
    },
  );

  it('drops empty legacy commit lists and leaves the other events unchanged', () => {
    const result = HooksConfigSchema.parse({
      pre_task: preTask,
      post_task: [],
      pre_commit: [],
      post_commit: [],
    });

    expect(result).toEqual({
      pre_task: [HookEntrySchema.parse(preTask[0])],
      post_task: [],
    });
    expect(result).not.toHaveProperty('pre_commit');
    expect(result).not.toHaveProperty('post_commit');
  });
});
