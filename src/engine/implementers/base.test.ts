import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './base.js';
import type { RunnerCallContext, RunnerCallResult } from '../calls/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { buildLanguageContext } from '../spec/prompts/language-context.js';
import { createChangeDetector } from '../change-detection.js';

let projectDir: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

type CompletedRunnerCallResult = Extract<RunnerCallResult, { status: 'completed' }>;
type FailureRunnerCallResult = Exclude<RunnerCallResult, CompletedRunnerCallResult>;

function makeRunnerCallResult(
  overrides: Pick<CompletedRunnerCallResult, 'status' | 'text'> &
    Partial<Omit<CompletedRunnerCallResult, 'status' | 'text'>>,
): CompletedRunnerCallResult;
function makeRunnerCallResult(
  overrides: Pick<FailureRunnerCallResult, 'status' | 'text' | 'error'> &
    Partial<Omit<FailureRunnerCallResult, 'status' | 'text' | 'error'>>,
): FailureRunnerCallResult;
function makeRunnerCallResult(
  overrides:
    | (Pick<CompletedRunnerCallResult, 'status' | 'text'> &
        Partial<Omit<CompletedRunnerCallResult, 'status' | 'text'>>)
    | (Pick<FailureRunnerCallResult, 'status' | 'text' | 'error'> &
        Partial<Omit<FailureRunnerCallResult, 'status' | 'text' | 'error'>>),
): RunnerCallResult {
  const base: Pick<
    RunnerCallResult,
    | 'callId'
    | 'role'
    | 'backendKind'
    | 'startedAt'
    | 'endedAt'
    | 'durationMs'
    | 'usage'
    | 'nativeSessionId'
    | 'toolUses'
    | 'artifacts'
    | 'warnings'
  > = {
    callId: 'call-test',
    role: 'implementer',
    backendKind: 'api',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
  };

  if (overrides.status === 'completed') {
    return {
      ...base,
      status: 'completed',
      text: overrides.text,
      usage: overrides.usage ?? base.usage,
      nativeSessionId: overrides.nativeSessionId ?? base.nativeSessionId,
      toolUses: overrides.toolUses ?? base.toolUses,
      artifacts: overrides.artifacts ?? base.artifacts,
      warnings: overrides.warnings ?? base.warnings,
      startedAt: overrides.startedAt ?? base.startedAt,
      endedAt: overrides.endedAt ?? base.endedAt,
      durationMs: overrides.durationMs ?? base.durationMs,
      error: null,
      partial: false,
    };
  }

  return {
    ...base,
    ...overrides,
    partial: overrides.partial ?? true,
  };
}

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
      task: makeTask(),
      projectDir,
      config,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('connection failed');
  });

  it('re-throws when shouldThrow returns true', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('command not found'));
    const implementer = createImplementerBase(
      makeBaseConfig({
        invoke,
        shouldThrow: (err) => err instanceof Error && err.message.includes('command not found'),
      }),
    );

    await expect(
      implementer.implement({
        task: makeTask(),
        projectDir,
        config: makeConfig(),
        context: defaultContext,
        onOutput: vi.fn(),
      }),
    ).rejects.toThrow('command not found');
  });

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
    const outside = createTempDir('impl-base-symlink-outside');
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

describe('createImplementerBase — runner call projection', () => {
  it('passes a fresh runner call context to each invoke attempt', async () => {
    const contexts: RunnerCallContext[] = [];
    const invoke = vi.fn().mockImplementation(async (opts: { callContext: RunnerCallContext }) => {
      contexts.push(opts.callContext);
      return makeRunnerCallResult({ status: 'completed', text: 'done', usage: null });
    });
    const implementer = createImplementerBase(
      makeBaseConfig({ extractsCode: false, backendKind: 'cli', invoke }),
    );
    const config = makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-5' } });
    const task = makeTask({ id: 'T001', file: 'src/context.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config,
      context: defaultContext,
      onOutput: vi.fn(),
    });
    await implementer.retry({
      task,
      projectDir,
      config,
      context: defaultContext,
      onOutput: vi.fn(),
      error: 'try again',
      attempt: 2,
      kind: 'local',
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5',
      attempt: 0,
    });
    expect(contexts[1]).toMatchObject({ attempt: 2 });
    expect(contexts[1]?.callId).not.toBe(contexts[0]?.callId);
  });

  it('returns failure for non-completed runner calls while preserving output and usage', async () => {
    const invoke = vi.fn().mockResolvedValue(
      makeRunnerCallResult({
        status: 'truncated',
        text: 'partial implementer output',
        usage: { inputTokens: 7, outputTokens: 3 },
        error: { code: 'max_tokens', message: 'output limit reached' },
        partial: true,
      }),
    );
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const task = makeTask({ id: 'T001', file: 'src/truncated.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.output).toBe('partial implementer output');
      expect(result.error).toBe('output limit reached');
      expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    }
    expect(existsSync(join(projectDir, 'src/truncated.ts'))).toBe(false);
  });

  it('maps user-aborted runner calls to the existing aborted result shape', async () => {
    const controller = new AbortController();
    const invoke = vi.fn().mockImplementation(async () => {
      controller.abort();
      return makeRunnerCallResult({
        status: 'aborted',
        text: 'partial before abort',
        usage: { inputTokens: 1, outputTokens: 1 },
        error: { code: 'runner_interrupted', message: 'stream interrupted' },
        partial: true,
      });
    });
    const implementer = createImplementerBase(makeBaseConfig({ extractsCode: false, invoke }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.output).toBe('partial before abort');
      expect(result.error).toBe('Aborted');
      expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    }
  });
});

describe('createImplementerBase — extractsCode pipeline success', () => {
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

describe('createImplementerBase — non-extracting backends (detectChanges)', () => {
  it('uses detectChanges when extractsCode is false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const implementer = createImplementerBase(
      makeBaseConfig({
        extractsCode: false,
        detectChanges,
      }),
    );

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
  });

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
