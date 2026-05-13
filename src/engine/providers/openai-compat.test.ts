import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenAICompatProvider } from './openai-compat.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('createOpenAICompatProvider', () => {
  setupFetchMock();

  afterEach(() => {
    delete process.env.TEST_PROVIDER_API_KEY;
  });

  it('creates a provider with correct name and apiBase', () => {
    const p = createOpenAICompatProvider('deepseek', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', false);
    expect(p.name).toBe('deepseek');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(p.isLocal).toBe(false);
  });

  it('uses override apiBase when provided', () => {
    const p = createOpenAICompatProvider(
      'deepseek',
      'https://api.deepseek.com/v1',
      'DEEPSEEK_API_KEY',
      false,
      { apiBase: 'https://custom.example.com/v1' },
    );
    expect(p.baseURL).toBe('https://custom.example.com/v1');
  });

  it.each([
    ['malformed JSON', async () => new Response('not json', { status: 200 })],
    ['missing data field', async () => new Response(JSON.stringify({ models: ['a'] }), { status: 200 })],
  ] as const)('listModels returns empty on %s', async (_label, mockFetch) => {
    process.env.TEST_PROVIDER_API_KEY = 'some-key';
    vi.mocked(globalThis.fetch).mockImplementation(mockFetch);
    const p = createOpenAICompatProvider('test', 'https://api.example.com/v1', 'TEST_PROVIDER_API_KEY', false);
    expect(await p.listModels()).toEqual([]);
  });

  it('returns empty without fetching when no api key on non-local provider', async () => {
    const p = createOpenAICompatProvider('test', 'https://api.example.com/v1', 'TEST_PROVIDER_API_KEY', false);
    const models = await p.listModels();
    expect(models).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('api key falls back to environment variable', () => {
    process.env.TEST_PROVIDER_API_KEY = 'from-env';
    const p = createOpenAICompatProvider('test', 'https://api.example.com/v1', 'TEST_PROVIDER_API_KEY', false);
    expect(p.apiKey()).toBe('from-env');
  });

  it('custom apiKey override takes precedence over env var', () => {
    process.env.TEST_PROVIDER_API_KEY = 'from-env';
    const p = createOpenAICompatProvider(
      'test',
      'https://api.example.com/v1',
      'TEST_PROVIDER_API_KEY',
      false,
      { apiKey: 'override-key' },
    );
    expect(p.apiKey()).toBe('override-key');
  });

  it('apiKey returns empty string when no key available', () => {
    const p = createOpenAICompatProvider('test', 'https://api.example.com/v1', 'TEST_PROVIDER_API_KEY', false);
    expect(p.apiKey()).toBe('');
  });
});
