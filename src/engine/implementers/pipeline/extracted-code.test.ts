import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';

let projectDir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  projectDir = createTempDir('impl-extracted-code');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createImplementerBase — extracted-code pipeline', () => {
  it('returns failure when the invoke output contains no extractable code', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: 'I think you should write this yourself.',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/nope.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/extract|code/i);
    expect(existsSync(join(projectDir, 'src/nope.ts'))).toBe(false);
  });

  itUnix('does not read task baseline content through final symlinks', async () => {
    const outside = createTempDir('impl-extracted-symlink-outside');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside secret');
      symlinkSync(join(outside, 'secret.ts'), join(projectDir, 'src', 'leak.ts'));

      const invoke = vi.fn().mockResolvedValue(
        makeRunnerCallResult({
          status: 'completed',
          text: '```ts\nexport const leaked = true;\n```',
          usage: null,
        }),
      );
      const implementer = createImplementerBase(makeBaseConfig({ invoke }));
      const task = makeTask({ id: 'T001', file: 'src/leak.ts', action: 'modify' });

      const result = await implementer.implement({
        task,
        projectDir,
        config: makeConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/escapes project directory|changed during approval/i);
      }
      expect(readFileSync(join(outside, 'secret.ts'), 'utf-8')).toBe('outside secret');
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('throws when task file path escapes projectDir', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nconst x = 1;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: '../escape.ts', action: 'create' });

    await expect(
      implementer.implement({
        task,
        projectDir,
        config: makeConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
      }),
    ).rejects.toThrow(/unsafe path/);
  });

  it('writes extracted code to disk and returns success with diff metrics', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'old content\n');

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const hello = () => "world";\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });

    const written = readFileSync(join(projectDir, 'src/hello.ts'), 'utf-8');
    expect(written).toContain('export const hello');
  });

  it('asks for approval before applying extracted code and leaves disk untouched when denied', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const denied = true;\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const approveWrite = vi.fn().mockResolvedValue({ allow: false, reason: 'approval denied' });
    const task = makeTask({ id: 'T001', file: 'src/denied.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      approveWrite,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('approval denied');
    expect(existsSync(join(projectDir, 'src/denied.ts'))).toBe(false);
  });

  it('blocks extracted-code writes when the target changes while approval is pending', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/race.ts'), 'export const value = "before";\n');

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const value = "implementer";\n```',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const approveWrite = vi.fn().mockImplementation(async () => {
      writeFileSync(join(projectDir, 'src/race.ts'), 'export const value = "user";\n');
      return { allow: true };
    });
    const task = makeTask({ id: 'T001', file: 'src/race.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      approveWrite,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('changed during approval');
    expect(readFileSync(join(projectDir, 'src/race.ts'), 'utf-8')).toBe(
      'export const value = "user";\n',
    );
  });
});
