import { describe, it, expect } from 'vitest';
import { createClient } from './providers.js';
import { makeConfig as makeBaseConfig } from '#testing/helpers/fixtures.js';
import type { Config } from '../types.js';

function makeConfig(overrides: Partial<Config['implementer']> = {}): Config {
  return makeBaseConfig({ implementer: overrides });
}

describe('createClient', () => {
  it('Ollama provider uses localhost:11434', () => {
    const client = createClient(makeConfig({ provider: 'ollama' }));
    expect(client.baseURL).toContain('localhost:11434');
  });

  it('LM Studio provider uses localhost:1234', () => {
    const client = createClient(makeConfig({ provider: 'lm-studio' }));
    expect(client.baseURL).toContain('localhost:1234');
  });

  it('DeepSeek provider uses deepseek.com', () => {
    const client = createClient(makeConfig({ provider: 'deepseek' }));
    expect(client.baseURL).toContain('deepseek.com');
  });

  it('OpenRouter provider uses openrouter.ai', () => {
    const client = createClient(makeConfig({ provider: 'openrouter' }));
    expect(client.baseURL).toContain('openrouter.ai');
  });

  it('custom apiBase overrides default baseURL', () => {
    const client = createClient(
      makeConfig({ provider: 'ollama', apiBase: 'http://my-server:9999/v1' }),
    );
    expect(client.baseURL).toBe('http://my-server:9999/v1');
  });

  it('unknown provider uses apiBase directly', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-ollama', apiBase: 'http://my-server:11434/v1' } as any),
    );
    expect(client.baseURL).toBe('http://my-server:11434/v1');
  });

  it('unknown provider uses apiKey from config', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-api', apiBase: 'http://api.example.com/v1', apiKey: 'sk-test123' } as any),
    );
    expect(client.baseURL).toBe('http://api.example.com/v1');
  });

  it('unknown provider falls back to empty string apiKey, not a placeholder', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-api', apiBase: 'http://api.example.com/v1' } as any),
    );
    expect(client.apiKey).toBe('');
  });
});

