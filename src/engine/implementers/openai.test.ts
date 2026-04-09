import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';

vi.mock('../providers/index.js', () => ({
  createClient: vi.fn(() => ({ __mockClient: true })),
  detectCapabilities: vi.fn(),
}));

vi.mock('../streaming/openai-stream.js', () => ({
  streamCompletion: vi.fn(),
}));

import { streamCompletion } from '../streaming/openai-stream.js';
import { createClient } from '../providers/index.js';
import { createOpenAIImplementer } from './openai.js';

describe('openai implementer', () => {
  let projectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    projectDir = mkdtempSync(join(tmpdir(), 'openai-impl-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes extracted code to disk and returns success with usage', async () => {
    const code = 'export function hello() {\n  return "hi";\n}\n';
    vi.mocked(streamCompletion).mockResolvedValue({
      text: '```typescript\n' + code + '```',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const implementer = createOpenAIImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/hello.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
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

    const implementer = createOpenAIImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/nowrite.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/extract|code/i);
    }

    expect(existsSync(join(projectDir, 'src/nowrite.ts'))).toBe(false);
  });

  it('returns failure with error message when streamCompletion rejects', async () => {
    vi.mocked(streamCompletion).mockRejectedValue(new Error('Connection timeout'));

    const implementer = createOpenAIImplementer(makeConfig());
    const task = makeTask({ id: 'T001', file: 'src/failed.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
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

    const implementer = createOpenAIImplementer(makeConfig());
    const task = makeTask({ id: 'T002', file: 'src/answer.ts', action: 'create' });

    const result = await implementer.implement({
      task,
      projectDir,
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 777, outputTokens: 333 });
  });

  it('retry() uses retry prompt and bumps temperature by retryTemperatureStep', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'export const x = 1;\n',
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const cfg = makeConfig({ implementer: { temperature: 0.2 } });
    const implementer = createOpenAIImplementer(cfg);
    const task = makeTask({ id: 'T003', file: 'src/retry.ts', action: 'create' });

    await implementer.retry({
      task,
      projectDir,
      config: cfg,
      context: defaultContext,
      onProgress: vi.fn(),
      error: 'previous failure',
      attempt: 2,
    });

    const call = vi.mocked(streamCompletion).mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('no stream call');
    const opts = call[3];
    expect(opts.temperature).toBeCloseTo(0.2 + 0.1 * 2, 5);
  });
});
