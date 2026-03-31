import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/engine/providers.js';
import type { Config } from '../src/types.js';

function makeConfig(overrides: Partial<Config['implementer']> = {}): Config {
  return {
    planner: { tool: 'claude-code' },
    implementer: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: '',
      contextLength: 32768,
      temperature: 0.2,
      ...overrides,
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
      commitPerTask: true,
    },
  };
}

describe('createClient', () => {
  it('Ollama provider uses localhost:11434', () => {
    const client = createClient(makeConfig({ provider: 'ollama' }));
    assert.ok(client.baseURL.includes('localhost:11434'));
  });

  it('LM Studio provider uses localhost:1234', () => {
    const client = createClient(makeConfig({ provider: 'lm-studio' }));
    assert.ok(client.baseURL.includes('localhost:1234'));
  });

  it('DeepSeek provider uses deepseek.com', () => {
    const client = createClient(makeConfig({ provider: 'deepseek' }));
    assert.ok(client.baseURL.includes('deepseek.com'));
  });

  it('OpenRouter provider uses openrouter.ai', () => {
    const client = createClient(makeConfig({ provider: 'openrouter' }));
    assert.ok(client.baseURL.includes('openrouter.ai'));
  });

  it('custom apiBase overrides default baseURL', () => {
    const client = createClient(
      makeConfig({ provider: 'ollama', apiBase: 'http://my-server:9999/v1' }),
    );
    assert.equal(client.baseURL, 'http://my-server:9999/v1');
  });

  it('unknown provider uses apiBase directly', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-ollama', apiBase: 'http://my-server:11434/v1' } as any),
    );
    assert.equal(client.baseURL, 'http://my-server:11434/v1');
  });

  it('unknown provider uses apiKey from config', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-api', apiBase: 'http://api.example.com/v1', apiKey: 'sk-test123' } as any),
    );
    assert.equal(client.baseURL, 'http://api.example.com/v1');
  });
});
