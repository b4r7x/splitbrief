import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';

vi.mock('../providers.js', () => ({
  createClient: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  readFileOrEmpty: vi.fn().mockReturnValue(''),
}));

vi.mock('../openai-stream.js', () => ({
  streamCompletion: vi.fn(),
}));

vi.mock('../implementer-utils.js', () => ({
  createGenEventEmitter: vi.fn().mockReturnValue(vi.fn()),
  processImplementerOutput: vi.fn(),
}));

vi.mock('../spec/formatter.js', () => ({
  formatTaskPrompt: vi.fn().mockReturnValue('formatted prompt'),
  formatRetryPrompt: vi.fn().mockReturnValue('retry prompt'),
  SYSTEM_PREAMBLE: 'system preamble',
}));

vi.mock('../spec/token-budget.js', () => ({
  estimateTokens: vi.fn().mockReturnValue(100),
}));

import { streamCompletion } from '../openai-stream.js';
import { processImplementerOutput } from '../implementer-utils.js';
import { implementTaskViaOpenAI, retryTaskViaOpenAI } from './openai.js';

describe('implementTaskViaOpenAI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success with usage on successful implementation', async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'export function hello() {}',
      usage,
    });
    vi.mocked(processImplementerOutput).mockResolvedValue({
      success: true,
      diff: '+export function hello() {}',
      linesAdded: 1,
      linesRemoved: 0,
    });

    const result = await implementTaskViaOpenAI({
      task: makeTask(),
      projectDir: '/tmp/proj',
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual(usage);
  });

  it('returns error when extraction fails', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'no code here, just explanation',
      usage: null,
    });
    vi.mocked(processImplementerOutput).mockResolvedValue({
      success: false,
      error: 'No code found in response',
    });

    const result = await implementTaskViaOpenAI({
      task: makeTask(),
      projectDir: '/tmp/proj',
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No code found in response');
  });

  it('returns error when stream throws', async () => {
    vi.mocked(streamCompletion).mockRejectedValue(new Error('Connection timeout'));

    const result = await implementTaskViaOpenAI({
      task: makeTask(),
      projectDir: '/tmp/proj',
      config: makeConfig(),
      context: defaultContext,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection timeout');
  });
});

describe('retryTaskViaOpenAI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success on successful retry', async () => {
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'fixed code',
      usage: { inputTokens: 200, outputTokens: 100 },
    });
    vi.mocked(processImplementerOutput).mockResolvedValue({
      success: true,
      diff: '+fixed',
      linesAdded: 1,
      linesRemoved: 0,
    });

    const result = await retryTaskViaOpenAI({
      task: makeTask(),
      projectDir: '/tmp/proj',
      config: makeConfig(),
      context: defaultContext,
      error: 'TS2322',
      attempt: 1,
      onProgress: vi.fn(),
    });

    expect(result.success).toBe(true);
  });
});
