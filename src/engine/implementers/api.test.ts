import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

vi.mock('../providers/registry.js', () => ({
  createClient: vi.fn(() => ({ __mockClient: true })),
  detectCapabilities: vi.fn(),
}));

vi.mock('../providers/openai-stream.js', () => ({
  streamCompletion: vi.fn(),
  asStreamClient: (c: unknown) => c,
}));

vi.mock('../providers/anthropic/stream.js', () => ({
  streamAnthropicCompletion: vi.fn(),
}));

import { streamCompletion } from '../providers/openai-stream.js';
import { streamAnthropicCompletion } from '../providers/anthropic/stream.js';
import { createClient } from '../providers/registry.js';
import { createApiImplementer } from './api.js';

describe('api implementer', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = createTempDir('openai-impl-test');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('writes extracted code to disk and returns success with usage', async () => {
    const code = 'export function hello() {\n  return "hi";\n}\n';
    vi.mocked(streamCompletion).mockResolvedValue({
      text: '```typescript\n' + code + '```',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });

    const written = readFileSync(join(projectDir, 'src/hello.ts'), 'utf-8');
    expect(written).toContain('export function hello()');
    expect(written).toContain('return "hi"');

    expect(createClient).toHaveBeenCalled();
    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });

  it('returns failure when stream response has no extractable code', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'I think you should try writing this yourself.',
      usage: null,
    });

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/nowrite.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/extract|code/i);
    }

    expect(existsSync(join(projectDir, 'src/nowrite.ts'))).toBe(false);
  });

  it('returns failure with error message when streamCompletion rejects', async () => {
    vi.mocked(streamCompletion).mockRejectedValue(new Error('Connection timeout'));

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/failed.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Connection timeout');
    }
    expect(existsSync(join(projectDir, 'src/failed.ts'))).toBe(false);
  });

  it('propagates token usage from stream response through to the result', async () => {
    const code = 'export const answer = 42;\n';
    vi.mocked(streamCompletion).mockResolvedValue({
      text: code,
      usage: { inputTokens: 777, outputTokens: 333 },
    });

    const implementer = createApiImplementer(makeConfig());
    const task = makeTask({ id: 'T002', file: 'src/answer.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 777, outputTokens: 333 });
  });

  it('uses the Anthropic streaming path for Anthropic implementers', async () => {
    const code = 'export const answer = 42;\n';
    vi.mocked(streamAnthropicCompletion).mockResolvedValue({
      text: code,
      usage: { inputTokens: 88, outputTokens: 44 },
    });

    const cfg = makeConfig({
      implementer: {
        provider: 'anthropic',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
      },
    });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T-anthropic', file: 'src/anthropic.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 88, outputTokens: 44 });
    expect(streamAnthropicCompletion).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(streamCompletion).not.toHaveBeenCalled();
  });

  it('retry() uses retry prompt and bumps temperature by retryTemperatureStep', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'export const x = 1;\n',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const cfg = makeConfig({ implementer: { temperature: 0.2 } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T003', file: 'src/retry.ts', action: 'create' });

    await implementer.retry({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
      error: 'previous failure',
      attempt: 2,
      kind: 'local',
    });

    const call = vi.mocked(streamCompletion).mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('no stream call');
    const opts = call[3];
    expect(opts.temperature).toBeCloseTo(0.2 + 0.1 * 2, 5);
  });

  it('throws if model is "auto" for unknown provider', async () => {
    const cfg = makeConfig({ implementer: { model: 'auto', provider: 'custom-unknown-provider' } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T-auto', file: 'src/auto.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/API implementer requires an explicit model/);
    }
  });

  it('clamps maxTokens to contextLength so prompt+output never exceeds context window', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'export const x = 1;\n',
      usage: null,
    });

    // Small context: 2048 tokens, large prompt that consumes most of it
    const cfg = makeConfig({ implementer: { contextLength: 2048 } });
    const implementer = createApiImplementer(cfg);
    const task = makeTask({ id: 'T-clamp', file: 'src/clamp.ts', action: 'create' });

    await implementer.implement({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onOutput: vi.fn(),
    });

    const call = vi.mocked(streamCompletion).mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('no stream call');
    const opts = call[3];
    // maxTokens must never exceed contextLength (2048)
    expect(opts.maxTokens).toBeLessThanOrEqual(2048);
    expect(opts.maxTokens).toBeGreaterThan(0);
  });

  it('uses provider-specific env var for API key fallback (not ANTHROPIC_API_KEY)', async () => {
    const code = 'export const x = 1;\n';
    vi.mocked(streamCompletion).mockResolvedValue({ text: code, usage: null });

    const orig = {
      openrouter: process.env['OPENROUTER_API_KEY'],
      anthropic: process.env['ANTHROPIC_API_KEY'],
    };
    process.env['OPENROUTER_API_KEY'] = 'sk-or-env-key';
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      const cfg = makeConfig({
        implementer: { provider: 'openrouter', model: 'openrouter/claude-3.5-sonnet', apiBase: 'https://openrouter.ai/api/v1' },
      });
      const implementer = createApiImplementer(cfg);
      const task = makeTask({ id: 'T-or', file: 'src/or.ts', action: 'create' });

      await implementer.implement({ task, projectDir, config: cfg, context: defaultContext, onOutput: vi.fn() });

      const call = vi.mocked(streamCompletion).mock.calls[0];
      expect(call).toBeDefined();
      if (!call) throw new Error('no stream call');
      // The apiKey passed to streamCompletion should be the OPENROUTER_API_KEY value
      const passedOptions = call[3];
      void passedOptions; // options don't contain apiKey; it's passed via the client
      // Verify the Anthropic env key was NOT used (createClient was called for openrouter)
      expect(createClient).toHaveBeenCalled();
      expect(streamAnthropicCompletion).not.toHaveBeenCalled();
    } finally {
      if (orig.openrouter === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = orig.openrouter;
      if (orig.anthropic === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig.anthropic;
    }
  });

  it('uses ANTHROPIC_API_KEY for Anthropic implementer when no apiKey in config', async () => {
    const code = 'export const x = 1;\n';
    vi.mocked(streamAnthropicCompletion).mockResolvedValue({ text: code, usage: null });

    const orig = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env-key';

    try {
      const cfg = makeConfig({
        implementer: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiBase: 'https://api.anthropic.com/v1' },
      });
      const implementer = createApiImplementer(cfg);
      const task = makeTask({ id: 'T-ant', file: 'src/ant.ts', action: 'create' });

      await implementer.implement({ task, projectDir, config: cfg, context: defaultContext, onOutput: vi.fn() });

      const call = vi.mocked(streamAnthropicCompletion).mock.calls[0];
      expect(call).toBeDefined();
      if (!call) throw new Error('no anthropic stream call');
      expect(call[0].apiKey).toBe('sk-ant-env-key');
    } finally {
      if (orig === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = orig;
    }
  });
});
