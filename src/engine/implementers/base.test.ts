import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './base.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { createChangeDetector } from '../change-detection.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-base');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createImplementerBase — error paths', () => {
  it('returns failure when invoke throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection failed'));
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir, config, context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('connection failed');
  });

  it('re-throws when shouldThrow returns true', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('command not found'));
    const implementer = createImplementerBase(makeBaseConfig({
      invoke,
      shouldThrow: (err) => err instanceof Error && err.message.includes('command not found'),
    }));

    await expect(
      implementer.implement({
        task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
      }),
    ).rejects.toThrow('command not found');
  });

  it('returns failure when the invoke output contains no extractable code', async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: 'I think you should write this yourself.',
      usage: null,
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/nope.ts', action: 'create' });

    const result = await implementer.implement({
      task, projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/extract|code/i);
    expect(existsSync(join(projectDir, 'src/nope.ts'))).toBe(false);
  });

  it('throws when task file path escapes projectDir', async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nconst x = 1;\n```',
      usage: null,
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: '../escape.ts', action: 'create' });

    await expect(
      implementer.implement({
        task, projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
      }),
    ).rejects.toThrow(/unsafe path/);
  });
});

describe('createImplementerBase — language-aware system preamble', () => {
  it('uses Python system guidance when a Python language context is provided', async () => {
    let seenPrompt = '';
    let seenSystemPreamble = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      seenSystemPreamble = opts.systemPreamble;
      return { text: 'done', usage: null };
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      languageContext: buildLanguageContext('python'),
      onOutput: vi.fn(),
    });

    expect(seenSystemPreamble).toContain('Python code generator');
    expect(seenSystemPreamble).not.toContain('TypeScript');
    expect(seenPrompt).toContain(seenSystemPreamble);
  });
});

describe('createImplementerBase — extractsCode pipeline success', () => {
  it('writes extracted code to disk and returns success with diff metrics', async () => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/hello.ts'), 'old content\n');

    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nexport const hello = () => "world";\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'modify' });

    const result = await implementer.implement({
      task, projectDir, config: makeConfig(), context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });

    const written = readFileSync(join(projectDir, 'src/hello.ts'), 'utf-8');
    expect(written).toContain('export const hello');
  });

  it('asks for approval before applying extracted code and leaves disk untouched when denied', async () => {
    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nexport const denied = true;\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
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

    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nexport const value = "implementer";\n```',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
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
    expect(readFileSync(join(projectDir, 'src/race.ts'), 'utf-8')).toBe('export const value = "user";\n');
  });
});

describe('createImplementerBase — non-extracting backends (detectChanges)', () => {
  it('uses detectChanges when extractsCode is false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));

    const result = await implementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

  it('ignores pre-existing dirty files and succeeds only when the backend writes a new file', async () => {
    const prePath = join(projectDir, 'src/pre-existing.ts');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(prePath, 'pre-existing content\n');

    const detectChanges = createChangeDetector('Direct implementer');
    const noChangeImplementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
      invoke: vi.fn().mockResolvedValue({ text: 'done', usage: null }),
    }));

    const noChange = await noChangeImplementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(noChange.success).toBe(false);
    if (!noChange.success) expect(noChange.error).toContain('without changing any files');

    const newPath = join(projectDir, 'src/new-file.ts');
    const writingImplementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
      invoke: vi.fn().mockImplementation(async () => {
        writeFileSync(newPath, 'export const created = true;\n');
        return { text: 'done', usage: null };
      }),
    }));

    const changed = await writingImplementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(changed.success).toBe(true);
    expect(readFileSync(prePath, 'utf-8')).toBe('pre-existing content\n');
    expect(readFileSync(newPath, 'utf-8')).toBe('export const created = true;\n');
  });

  it('returns success when extractsCode is false and no detectChanges provided', async () => {
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false }));

    const result = await implementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

  it('returns failure when detectChanges reports no changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'No files changed' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
      invoke: vi.fn().mockResolvedValue({ text: 'done', usage: { inputTokens: 10, outputTokens: 20 } }),
    }));

    const result = await implementer.implement({
      task: makeTask(), projectDir, config: makeConfig(), context: defaultContext, onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('No files changed');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    }
  });
});

describe('createImplementerBase — retry', () => {
  it.each([
    ['local', 2, 'tsc failed'],
    ['hint', 1, 'lint failed'],
  ] as const)('succeeds on retry for kind "%s"', async (kind, attempt, error) => {
    const invoke = vi.fn().mockResolvedValue({
      text: '```ts\nconst x = 1;\n```',
      usage: null,
    });
    const implementer = createImplementerBase(makeBaseConfig({ invoke, retryTemperatureStep: 0.1 }));
    const task = makeTask({ id: 'T001', file: 'src/retry.ts', action: 'create' });

    const result = await implementer.retry({
      task, projectDir, config: makeConfig(), context: defaultContext,
      onOutput: vi.fn(), error, attempt, kind,
    });

    expect(result.success).toBe(true);
  });
});
