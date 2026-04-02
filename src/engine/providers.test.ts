import { describe, it, expect } from 'vitest';
import { createClient, DEFAULT_BASES } from './providers.js';
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

describe('DEFAULT_BASES', () => {
  it('is exported and contains known providers', () => {
    expect(DEFAULT_BASES.ollama).toBeTruthy();
    expect(DEFAULT_BASES['lm-studio']).toBeTruthy();
    expect(DEFAULT_BASES.deepseek).toBeTruthy();
    expect(DEFAULT_BASES.openrouter).toBeTruthy();
  });

  it('Ollama default baseURL ends with /v1', () => {
    expect(DEFAULT_BASES.ollama.baseURL).toBe('http://localhost:11434/v1');
  });
});

describe('Ollama URL construction for native API', () => {
  it('strips /v1 suffix from default Ollama baseURL', () => {
    const base = DEFAULT_BASES.ollama.baseURL.replace(/\/v1\/?$/, '');
    expect(base).toBe('http://localhost:11434');
    expect(`${base}/api/show`).toBe('http://localhost:11434/api/show');
  });

  it('strips /v1 suffix from custom Ollama apiBase', () => {
    const apiBase = 'http://my-server:11434/v1';
    const base = apiBase.replace(/\/v1\/?$/, '');
    expect(base).toBe('http://my-server:11434');
    expect(`${base}/api/show`).toBe('http://my-server:11434/api/show');
  });

  it('strips /v1/ with trailing slash', () => {
    const apiBase = 'http://my-server:11434/v1/';
    const base = apiBase.replace(/\/v1\/?$/, '');
    expect(base).toBe('http://my-server:11434');
  });

  it('does not strip partial /v1 matches', () => {
    const apiBase = 'http://my-server:11434/v1beta';
    const base = apiBase.replace(/\/v1\/?$/, '');
    expect(base).toBe('http://my-server:11434/v1beta');
  });
});
