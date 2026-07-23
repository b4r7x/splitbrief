import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { buildLanguageContext } from '../../spec/prompts/language-context.js';
import { createChangeDetector } from '../../change-detection.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-base');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createImplementerBase — language-aware system preamble', () => {
  it('uses Python system guidance when a Python language context is provided', async () => {
    let seenPrompt = '';
    let seenSystemPreamble = '';
    const invoke = vi.fn().mockImplementation(async (opts) => {
      seenPrompt = opts.prompt;
      seenSystemPreamble = opts.systemPreamble;
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
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

describe('createImplementerBase — non-extracting backends (detectChanges)', () => {
  it('ignores pre-existing dirty files and succeeds only when the backend writes a new file', async () => {
    const prePath = join(projectDir, 'src/pre-existing.ts');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(prePath, 'pre-existing content\n');

    const detectChanges = createChangeDetector('Direct implementer');
    const noChangeImplementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi
          .fn()
          .mockResolvedValue(
            makeRunnerCallResult({ status: 'completed', text: 'done', usage: null }),
          ),
      }),
    );

    const noChange = await noChangeImplementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(noChange.success).toBe(false);
    if (!noChange.success) expect(noChange.error).toContain('without changing any files');

    const newPath = join(projectDir, 'src/new-file.ts');
    const writingImplementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi.fn().mockImplementation(async () => {
          writeFileSync(newPath, 'export const created = true;\n');
          return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
        }),
      }),
    );

    const changed = await writingImplementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(changed.success).toBe(true);
    expect(readFileSync(prePath, 'utf-8')).toBe('pre-existing content\n');
    expect(readFileSync(newPath, 'utf-8')).toBe('export const created = true;\n');
  });

  it('returns success when extractsCode is false and no detectChanges provided', async () => {
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

  it('returns failure when detectChanges reports no changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'No files changed' });
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
        invoke: vi.fn().mockResolvedValue(
          makeRunnerCallResult({
            status: 'completed',
            text: 'done',
            usage: { inputTokens: 10, outputTokens: 20 },
          }),
        ),
      }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
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
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'completed',
        text: '```ts\nconst x = 1;\n```',
        usage: null,
      }),
    );
    const implementer = createImplementerBase(
      makeBaseConfig({ invoke, retryTemperatureStep: 0.1 }),
    );
    const task = makeTask({ id: 'T001', file: 'src/retry.ts', action: 'create' });

    const result = await implementer.retry({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      error,
      attempt,
      kind,
    });

    expect(result.success).toBe(true);
  });
});
