import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createImplementerBase } from './run.js';
import type { RunnerCallContext } from '../../calls/types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBaseConfig } from '#testing/helpers/factories/implementer-base.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { processError } from '../../../lib/process/errors.js';

let projectDir: string;

beforeEach(() => {
  projectDir = createTempDir('impl-call-result');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createImplementerBase — invoke and runner-call projection', () => {
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

  it('resolves a watchdog idle-kill to a failed result so the task retry ladder handles it', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(processError.idleTimeout({ command: 'fake-runner', idleMs: 300_000 }));
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));

    const result = await implementer.implement({
      task: makeTask(),
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('produced no output for 300s');
  });

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
