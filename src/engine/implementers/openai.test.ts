import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';

vi.mock('../providers.js', () => ({
  createClient: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  readFileOrEmpty: vi.fn().mockReturnValue(''),
}));

vi.mock('../streaming/openai-stream.js', () => ({
  streamCompletion: vi.fn(),
}));

vi.mock('../parsers/response-extractor.js', () => ({
  extractCode: vi.fn(),
}));

vi.mock('../orchestrator/apply.js', () => ({
  applyCode: vi.fn(),
}));

vi.mock('../../utils/diff.js', () => ({
  computeDiff: vi.fn(),
}));

vi.mock('../spec/formatter.js', () => ({
  formatTaskPrompt: vi.fn().mockReturnValue('formatted prompt'),
  formatRetryPrompt: vi.fn().mockReturnValue('retry prompt'),
  SYSTEM_PREAMBLE: 'system preamble',
}));

vi.mock('../spec/token-budget.js', () => ({
  estimateTokens: vi.fn().mockReturnValue(100),
}));

import { streamCompletion } from '../streaming/openai-stream.js';
import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from '../orchestrator/apply.js';
import { computeDiff } from '../../utils/diff.js';
import { createOpenAIImplementer } from './openai.js';

describe('openai implementer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success with usage on successful implementation', async () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    vi.mocked(streamCompletion).mockResolvedValue({
      text: 'export function hello() {}',
      usage,
    });
    vi.mocked(extractCode).mockReturnValue({ code: 'export function hello() {}', confidence: 'high' });
    vi.mocked(applyCode).mockReturnValue({ success: true });
    vi.mocked(computeDiff).mockReturnValue({ diff: '+export function hello() {}', linesAdded: 1, linesRemoved: 0 });

    const implementer = createOpenAIImplementer(makeConfig());
    const result = await implementer.implement({
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
    vi.mocked(extractCode).mockReturnValue({ error: 'No code found in response' });

    const implementer = createOpenAIImplementer(makeConfig());
    const result = await implementer.implement({
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

    const implementer = createOpenAIImplementer(makeConfig());
    const result = await implementer.implement({
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

