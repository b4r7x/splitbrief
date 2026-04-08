import { describe, it, expect, vi } from 'vitest';
import { createImplementerBase, type ImplementerBaseConfig } from './base.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';

vi.mock('../parsers/response-extractor.js', () => ({
  extractCode: vi.fn(),
}));

vi.mock('../orchestrator/apply.js', () => ({
  applyCode: vi.fn(),
}));

vi.mock('../../utils/diff.js', () => ({
  computeDiff: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  readFileOrEmpty: vi.fn().mockReturnValue(''),
}));

import { extractCode } from '../parsers/response-extractor.js';
import { applyCode } from '../orchestrator/apply.js';
import { computeDiff } from '../../utils/diff.js';

function makeBaseConfig(overrides?: Partial<ImplementerBaseConfig>): ImplementerBaseConfig {
  return {
    name: 'test',
    pricingKey: 'ollama',
    extractsCode: true,
    invoke: vi.fn().mockResolvedValue({ text: 'code output', usage: { inputTokens: 10, outputTokens: 20 } }),
    buildPrompt: vi.fn().mockReturnValue('test prompt'),
    buildRetryPrompt: vi.fn().mockReturnValue('retry prompt'),
    isAvailable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function mockSuccessfulExtraction() {
  vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
  vi.mocked(applyCode).mockReturnValue({ success: true });
  vi.mocked(computeDiff).mockReturnValue({ diff: '+line', linesAdded: 1, linesRemoved: 0 });
}

describe('createImplementerBase', () => {
  it('returns failure when invoke throws', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('connection failed'));
    const implementer = createImplementerBase(makeBaseConfig({ invoke }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('connection failed');
  });

  it('re-throws when shouldThrow returns true', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('command not found'));
    const implementer = createImplementerBase(makeBaseConfig({
      invoke,
      shouldThrow: (err) => err instanceof Error && err.message.includes('command not found'),
    }));
    const config = makeConfig();

    await expect(
      implementer.implement({ task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn() }),
    ).rejects.toThrow('command not found');
  });

  it('returns failure when code extraction fails', async () => {
    vi.mocked(extractCode).mockReturnValue({ error: 'No code found' });

    const implementer = createImplementerBase(makeBaseConfig());
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No code found');
  });

  it('returns failure when applyCode fails', async () => {
    vi.mocked(extractCode).mockReturnValue({ code: 'const x = 1;', confidence: 'high' });
    vi.mocked(applyCode).mockReturnValue({ success: false, error: 'Write failed' });

    const implementer = createImplementerBase(makeBaseConfig());
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Write failed');
  });

  it('uses detectChanges when extractsCode is false', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: true, output: '' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn(),
    });

    expect(detectChanges).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('returns failure when detectChanges finds no changes', async () => {
    const detectChanges = vi.fn().mockResolvedValue({ changed: false, output: 'No files changed' });
    const implementer = createImplementerBase(makeBaseConfig({
      extractsCode: false,
      detectChanges,
    }));
    const config = makeConfig();

    const result = await implementer.implement({
      task: makeTask(), projectDir: '/tmp', config, context: defaultContext, onProgress: vi.fn(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No files changed');
  });

});

