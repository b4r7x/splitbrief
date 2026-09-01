import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatProvider } from './openai-compat.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

describe('createOpenAICompatProvider', () => {
  setupFetchMock();

  const environmentKeys = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TEST_PROVIDER_API_KEY'];
  const originalEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    originalEnvironment.clear();
    for (const key of environmentKeys) originalEnvironment.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('creates a provider with correct name and apiBase', () => {
    const provider = createOpenAICompatProvider({
      name: 'deepseek',
      defaultBaseURL: 'https://api.deepseek.com/v1',
      envKeyName: 'DEEPSEEK_API_KEY',
    });
    expect(provider.name).toBe('deepseek');
    expect(provider.baseURL).toBe('https://api.deepseek.com/v1');
    expect(provider.isLocal).toBe(false);
  });

  it('rejects a known provider override outside its declared endpoint policy', () => {
    expect(() =>
      createOpenAICompatProvider({
        name: 'lm-studio',
        defaultBaseURL: 'http://localhost:1234/v1',
        envKeyName: '',
        overrides: { apiBase: 'https://custom.example.com/v1' },
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('keeps OpenAI generation and private fine-tune IDs while excluding known non-text families', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-5.4' },
            { id: 'ft:gpt-5.4:customer:private' },
            { id: 'text-embedding-3-large' },
            { id: 'omni-moderation-latest' },
            { id: 'gpt-image-1' },
            { id: 'chatgpt-image-latest' },
            { id: 'dall-e-3' },
            { id: 'sora-2' },
            { id: 'gpt-4o-audio-preview' },
            { id: 'whisper-1' },
            { id: 'tts-1' },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createOpenAICompatProvider({
      name: 'openai',
      defaultBaseURL: 'https://api.openai.com/v1',
      envKeyName: 'OPENAI_API_KEY',
    });

    expect(await provider.listModels()).toEqual(['gpt-5.4', 'ft:gpt-5.4:customer:private']);
  });

  it('keeps unknown and private DeepSeek IDs while excluding known non-generative families', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'deepseek-chat' },
            { id: 'private-customer-model' },
            { id: 'deepseek-embedding-v1' },
            { id: 'deepseek-reranker-v2' },
          ],
        }),
        { status: 200 },
      ),
    );

    const provider = createOpenAICompatProvider({
      name: 'deepseek',
      defaultBaseURL: 'https://api.deepseek.com/v1',
      envKeyName: 'DEEPSEEK_API_KEY',
    });

    expect(await provider.listModels()).toEqual(['deepseek-chat', 'private-customer-model']);
  });

  it('does not apply a known-provider exclusion policy to an unknown provider', async () => {
    process.env.TEST_PROVIDER_API_KEY = 'some-key';
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'customer-embedding-compatible-model' }] }), {
        status: 200,
      }),
    );

    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
    });

    expect(await provider.listModels()).toEqual(['customer-embedding-compatible-model']);
  });

  it.each([
    ['malformed JSON', async () => new Response('not json', { status: 200 })],
    [
      'missing data field',
      async () => new Response(JSON.stringify({ models: ['a'] }), { status: 200 }),
    ],
  ] as const)('does not turn %s into a model list', async (_label, mockFetch) => {
    process.env.TEST_PROVIDER_API_KEY = 'some-key';
    vi.mocked(globalThis.fetch).mockImplementation(mockFetch);
    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
    });
    expect(await provider.listModels()).toEqual([]);
  });

  it('retains an HTTP 403 diagnostic for upstream policy classification', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('denied', { status: 403 }));

    const provider = createOpenAICompatProvider({
      name: 'openai',
      defaultBaseURL: 'https://api.openai.com/v1',
      envKeyName: 'OPENAI_API_KEY',
    });

    expect(await provider.listModels()).toEqual([]);
    expect(provider.getLastError?.()).toBe('HTTP 403');
  });

  it('returns empty without fetching when no api key is available for a remote provider', async () => {
    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
    });
    expect(await provider.listModels()).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('uses an environment key when no explicit override is configured', () => {
    process.env.TEST_PROVIDER_API_KEY = 'from-env';
    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
    });
    expect(provider.apiKey()).toBe('from-env');
  });

  it('prefers an explicit api key override over the environment', () => {
    process.env.TEST_PROVIDER_API_KEY = 'from-env';
    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
      overrides: { apiKey: 'override-key' },
    });
    expect(provider.apiKey()).toBe('override-key');
  });

  it('returns an empty api key string when no key is available', () => {
    const provider = createOpenAICompatProvider({
      name: 'test',
      defaultBaseURL: 'https://api.example.com/v1',
      envKeyName: 'TEST_PROVIDER_API_KEY',
    });
    expect(provider.apiKey()).toBe('');
  });
});
