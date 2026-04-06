import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../../types.js';

vi.mock('../openai-stream.js', () => ({
  streamCompletion: vi.fn().mockResolvedValue({
    text: 'mocked response',
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
}));

vi.mock('openai', () => ({
  default: class {
    models = { list: vi.fn().mockResolvedValue({ data: [] }) };
    constructor(public opts: Record<string, unknown>) {}
  },
}));

function makeConfig(provider: string, overrides?: Partial<Config['planner']>): Config {
  return {
    planner: {
      tool: 'claude-code',
      provider,
      model: 'test-model',
      apiBase: 'http://localhost:11434/v1',
      ...overrides,
    },
    implementer: {
      provider: 'ollama',
      model: 'test',
      apiBase: '',
      contextLength: 8192,
      temperature: 0.3,
    },
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitStrategy: 'none',
    },
  };
}

describe('createApiPlanner', () => {
  it('plan calls streamCompletion', async () => {
    const { streamCompletion } = await import('../openai-stream.js');
    const { createApiPlanner } = await import('./api.js');
    const planner = createApiPlanner(makeConfig('ollama'));

    const config = makeConfig('ollama');
    const callbacks = { onOutput: vi.fn() };
    await planner.plan('do stuff', '/tmp/test', config, callbacks);

    expect(streamCompletion).toHaveBeenCalled();
  });

  it('has correct name format', async () => {
    const { createApiPlanner } = await import('./api.js');
    const planner = createApiPlanner(makeConfig('deepseek'));
    expect(planner.name).toBe('api:deepseek');
  });

  it('isAvailable delegates to OpenAI client', async () => {
    const { createApiPlanner } = await import('./api.js');
    const planner = createApiPlanner(makeConfig('ollama'));
    const available = await planner.isAvailable();
    expect(available).toBe(true);
  });

  it('getVersion returns the configured model', async () => {
    const { createApiPlanner } = await import('./api.js');
    const planner = createApiPlanner(makeConfig('ollama', { model: 'qwen2.5:32b' }));
    const version = await planner.getVersion();
    expect(version).toBe('qwen2.5:32b');
  });

  it('is not conversational', async () => {
    const { createApiPlanner } = await import('./api.js');
    const planner = createApiPlanner(makeConfig('ollama'));
    expect(planner.conversational).toBe(false);
  });
});
