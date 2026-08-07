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

  it('refuses a marker-less modify response that would discard most of the file, leaving disk untouched', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(
      join(projectDir, 'src/app.ts'),
      'import { z } from "zod";\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
    );

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const a = 1;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/app.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('1 of 6');
      expect(result.error).toContain('<<<<<<< SEARCH');
      expect(result.error).toContain('>>>>>>> REPLACE');
    }
    expect(readFileSync(join(projectDir, 'src/app.ts'), 'utf-8')).toContain('export const e = 5');
  });

  it('refuses a malformed marker payload instead of letting it bypass the shrink guard', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const original = `${Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;
    writeFileSync(join(projectDir, 'src/app.ts'), original);

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\n<<<<<<< SEARCH \nexport const v0 = 0;\n=======\nexport const v0 = 42;\n>>>>>>> REPLACE\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/app.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('keeps 5 of 20');
    expect(readFileSync(join(projectDir, 'src/app.ts'), 'utf-8')).toBe(original);
  });

  it('fails a truncated marker payload without writing marker text to disk', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    const original = 'export const a = 1;\nexport const b = 2;\n';
    writeFileSync(join(projectDir, 'src/app.ts'), original);

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 42;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/app.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Malformed SEARCH/REPLACE block');
    expect(readFileSync(join(projectDir, 'src/app.ts'), 'utf-8')).toBe(original);
  });

  it('applies a legitimate whole-file rewrite that keeps most of the existing lines', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(
      join(projectDir, 'src/app.ts'),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
    );

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/app.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/app.ts'), 'utf-8')).toContain('export const f = 6');
  });

  it('applies a search/replace patch even when the resulting patch is small', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(
      join(projectDir, 'src/app.ts'),
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
    );

    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 42;\n>>>>>>> REPLACE\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/app.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    const written = readFileSync(join(projectDir, 'src/app.ts'), 'utf-8');
    expect(written).toContain('export const a = 42');
    expect(written).toContain('export const e = 5');
  });

  it('writes the response for a modify task whose target does not exist', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nexport const fresh = true;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/fresh.ts', action: 'modify' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(readFileSync(join(projectDir, 'src/fresh.ts'), 'utf-8')).toContain('export const fresh');
  });
});
