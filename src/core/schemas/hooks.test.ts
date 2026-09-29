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

  it.each([
    [{ command: '/usr/local/bin/bash', args: ['./hooks/check.sh'] }],
    [{ command: '/opt/homebrew/bin/fish' }],
    [{ command: './bin/zsh' }],
    [{ command: 'BASH' }],
    [{ command: 'env', args: ['node', 'hooks/check.mjs'] }],
    [{ command: 'nice', args: ['/opt/homebrew/bin/bash', 'hooks/check.sh'] }],
    [{ command: 'nice', args: ['/usr/local/bin/env', '-S', 'hooks/check.sh'] }],
  ])('rejects the shell launcher in %o by its basename', (entry) => {
    expect(HookEntrySchema.safeParse(entry).success).toBe(false);
  });

  it.each(['-ec', '-xc', '-lc', '-cx', '--command=true'])(
    'rejects the shell-evaluation flag %s in hook args',
    (flag) => {
      const result = HookEntrySchema.safeParse({ command: './hooks/run', args: [flag, 'true'] });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ path: ['args', 0], message: expect.stringContaining(flag) }),
      );
    },
  );

  it.each([
    [{ command: 'npx', args: ['--call', 'npm run check'] }, 0, '--call'],
    [{ command: 'npx', args: ['--call=npm run check'] }, 0, '--call=npm run check'],
    [{ command: '/usr/local/bin/NPX', args: ['--call=npm run check'] }, 0, '--call=npm run check'],
    [
      { command: 'npx', args: ['--cache', '.cache', '--call=npm run check'] },
      2,
      '--call=npm run check',
    ],
    [
      { command: 'npx', args: ['--userconfig', '.npmrc', '--call=npm run check'] },
      2,
      '--call=npm run check',
    ],
    [{ command: 'npm', args: ['exec', '--call', 'npm run check'] }, 1, '--call'],
    [{ command: 'npm', args: ['--silent', 'exec', '--call=npm check'] }, 2, '--call=npm check'],
    [{ command: 'npm', args: ['x', '--call=npm run check'] }, 1, '--call=npm run check'],
    [{ command: 'npm', args: ['--call=npm run check', 'exec'] }, 0, '--call=npm run check'],
    [{ command: 'npm', args: ['--call', 'npm run check', 'exec'] }, 0, '--call'],
    [
      {
        command: 'npx',
        args: ['--registry', 'https://registry.npmjs.org', '--call', 'npm run check'],
      },
      2,
      '--call',
    ],
    [
      { command: 'npx', args: ['--loglevel', 'silly', '--call=npm run check'] },
      2,
      '--call=npm run check',
    ],
    [{ command: 'npx', args: ['--omit', 'dev', '--call', 'npm run check'] }, 2, '--call'],
    [{ command: 'npm', args: ['--omit', 'dev', 'exec', '--call', 'npm run check'] }, 3, '--call'],
    [
      { command: 'npm', args: ['--tag', 'next', 'exec', '--call=npm run check'] },
      3,
      '--call=npm run check',
    ],
    [{ command: 'npm', args: ['--call', 'npm run check', '--', 'exec'] }, 0, '--call'],
    [{ command: 'npm', args: ['exec', '-c=npm run check'] }, 1, '-c=npm run check'],
    [{ command: 'npm', args: ['exec', '--c=npm run check'] }, 1, '--c=npm run check'],
    [{ command: 'npx', args: ['--c=npm run check'] }, 0, '--c=npm run check'],
  ] as const)('rejects the npx/npm exec command-string option in %o', (entry, index, flag) => {
    const result = HookEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ['args', index], message: expect.stringContaining(flag) }),
    );
  });

  it.each([
    [{ command: 'node', args: ['hooks/check.mjs'] }],
    [{ command: 'npx', args: ['prettier', '--check', 'src/app.ts'] }],
    [{ command: './hooks/check.sh', args: ['--rules=./hooks/rules.json', '-v'] }],
    [{ command: '/usr/local/bin/shellcheck', args: ['hooks/check.sh'] }],
  ])('accepts the script hook %o', (entry) => {
    expect(HookEntrySchema.safeParse(entry).success).toBe(true);
  });

  it.each([
    [{ command: './hooks/check.sh', args: ['--call', 'rules.json'] }],
    [{ command: 'npm', args: ['--call', 'exec'] }],
    [{ command: 'npm', args: ['test', '--call=literal'] }],
    [{ command: 'npx', args: ['--', '--call'] }],
    [{ command: 'npm', args: ['exec', '--', '--call'] }],
    [{ command: 'npx', args: ['prettier', '--call'] }],
    [{ command: 'npx', args: ['--yes', 'prettier', '--call'] }],
    [{ command: 'npx', args: ['--package', 'prettier', '--', '--call'] }],
    [{ command: 'npx', args: ['--registry', 'https://registry.npmjs.org', 'prettier', '--call'] }],
    [{ command: 'npx', args: ['--force', 'prettier', '--call'] }],
    [{ command: 'npm', args: ['--yes', 'test', '--call=literal'] }],
    [{ command: 'npm', args: ['--omit', 'dev', 'test', '--call=literal'] }],
    [{ command: 'npm', args: ['--call', 'npm run check', '--', 'prettier'] }],
  ])('accepts the literal --call argument in %o outside an npx/npm exec option', (entry) => {
    expect(HookEntrySchema.safeParse(entry).success).toBe(true);
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
