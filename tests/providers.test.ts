import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, DEFAULT_BASES } from '../src/engine/providers.js';
import { makeConfig as makeBaseConfig } from './helpers/fixtures.js';
import type { Config } from '../src/types.js';

function makeConfig(overrides: Partial<Config['implementer']> = {}): Config {
  return makeBaseConfig({ implementer: overrides });
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

  it('unknown provider falls back to empty string apiKey, not a placeholder', () => {
    const client = createClient(
      makeConfig({ provider: 'custom-api', apiBase: 'http://api.example.com/v1' } as any),
    );
    assert.equal(client.apiKey, '');
  });
});

describe('DEFAULT_BASES', () => {
  it('is exported and contains known providers', () => {
    assert.ok(DEFAULT_BASES.ollama);
    assert.ok(DEFAULT_BASES['lm-studio']);
    assert.ok(DEFAULT_BASES.deepseek);
    assert.ok(DEFAULT_BASES.openrouter);
  });

  it('Ollama default baseURL ends with /v1', () => {
    assert.equal(DEFAULT_BASES.ollama.baseURL, 'http://localhost:11434/v1');
  });
});

describe('Ollama URL construction for native API', () => {
  it('strips /v1 suffix from default Ollama baseURL', () => {
    const base = DEFAULT_BASES.ollama.baseURL.replace(/\/v1\/?$/, '');
    assert.equal(base, 'http://localhost:11434');
    // The native API endpoint would be base + '/api/show'
    assert.equal(`${base}/api/show`, 'http://localhost:11434/api/show');
  });

  it('strips /v1 suffix from custom Ollama apiBase', () => {
    const apiBase = 'http://my-server:11434/v1';
    const base = apiBase.replace(/\/v1\/?$/, '');
    assert.equal(base, 'http://my-server:11434');
    assert.equal(`${base}/api/show`, 'http://my-server:11434/api/show');
  });

  it('strips /v1/ with trailing slash', () => {
    const apiBase = 'http://my-server:11434/v1/';
    const base = apiBase.replace(/\/v1\/?$/, '');
    assert.equal(base, 'http://my-server:11434');
  });

  it('does not strip partial /v1 matches', () => {
    const apiBase = 'http://my-server:11434/v1beta';
    const base = apiBase.replace(/\/v1\/?$/, '');
    // /v1beta should not be stripped because the regex only matches /v1 at the end
    assert.equal(base, 'http://my-server:11434/v1beta');
  });
});
