import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  KNOWN_PROVIDERS,
  getProvider,
  detectAvailableProviders,
  detectCapabilities,
} from './registry.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import type { Config } from '../../core/schemas/config.js';

describe('getProvider', () => {
  setupFetchMock();

  it('returns generic provider for unknown name', () => {
    const p = getProvider('custom-api', {
      apiBase: 'http://api.example.com/v1',
      apiKey: 'sk-test',
    });
    expect(p.name).toBe('custom-api');
    expect(p.baseURL).toBe('http://api.example.com/v1');
    expect(p.apiKey()).toBe('sk-test');
  });

  it('returns valid provider for known openai-compat name (deepseek)', () => {
    const p = getProvider('deepseek');
    expect(p.name).toBe('deepseek');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(typeof p.apiKey()).toBe('string');
  });

  it('throws for unknown provider without apiBase', () => {
    expect(() => getProvider('unknown-provider')).toThrow(/apiBase/);
  });

  it('rejects apiBase values that are not http URLs', () => {
    expect(() =>
      getProvider('custom-api', { apiBase: 'file:///tmp/socket', apiKey: 'sk-test' }),
    ).toThrow(/http or https/);
  });

  it('rejects apiBase values with embedded credentials', () => {
    expect(() =>
      getProvider('custom-api', { apiBase: 'https://user:pass@example.com/v1', apiKey: 'sk-test' }),
    ).toThrow(/must not include credentials/);
  });

  it('lists Anthropic models with Anthropic headers', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'claude-sonnet-4-6', created_at: '2025-02-19T00:00:00Z' }],
        }),
        { status: 200 },
      ),
    );

    const provider = getProvider('anthropic', {
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
    });
    const models = await provider.listModels();

    expect(models).toEqual(['claude-sonnet-4-6']);
  });
});

describe('apiKey env references', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolves env: apiKey overrides for known providers', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env-key';
    const p = getProvider('openrouter', { apiKey: 'env:OPENROUTER_API_KEY' });
    expect(p.apiKey()).toBe('sk-or-env-key');
  });

  it('throws when an env: apiKey override references a missing variable', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => getProvider('openrouter', { apiKey: 'env:OPENROUTER_API_KEY' })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });

  it('throws when an env: apiKey override has an empty variable name', () => {
    expect(() => getProvider('openrouter', { apiKey: 'env:' })).toThrow(/env:VARIABLE_NAME/);
  });

  it('throws when an env: apiKey override has a whitespace-only variable name', () => {
    expect(() => getProvider('openrouter', { apiKey: 'env:   ' })).toThrow(/env:VARIABLE_NAME/);
  });

  it('rejects env-referenced keys with a custom apiBase for known providers', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env-key';
    expect(() =>
      getProvider('openrouter', {
        apiBase: 'https://proxy.example.com/v1',
        apiKey: 'env:OPENROUTER_API_KEY',
      }),
    ).toThrow(/exfiltrat/i);
  });
});

describe('apiBase exfiltration guard', () => {
  setupFetchMock();
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('rejects known provider with env-sourced key and custom apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    expect(() => getProvider('openai', { apiBase: 'https://evil.example.com/v1' })).toThrow(
      /exfiltrat/i,
    );
  });

  it('allows known provider with inline apiKey and custom apiBase', () => {
    delete process.env.OPENAI_API_KEY;
    const p = getProvider('openai', {
      apiBase: 'https://proxy.example.com/v1',
      apiKey: 'sk-inline',
    });
    expect(p.baseURL).toBe('https://proxy.example.com/v1');
  });

  it('allows unknown provider with custom apiBase', () => {
    const p = getProvider('my-custom-provider', {
      apiBase: 'https://custom.example.com/v1',
      apiKey: 'sk-custom',
    });
    expect(p.name).toBe('my-custom-provider');
    expect(p.baseURL).toBe('https://custom.example.com/v1');
  });

  it('rejects unknown provider with env apiKey reference and custom apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    expect(() =>
      getProvider('my-custom-provider', {
        apiBase: 'https://custom.example.com/v1',
        apiKey: 'env:OPENAI_API_KEY',
      }),
    ).toThrow(/custom\/unknown provider.*env apiKey reference.*apiBase.*exfiltration risk/i);
  });

  it('allows known provider with default apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    const p = getProvider('openai', { apiBase: 'https://api.openai.com/v1' });
    expect(p.name).toBe('openai');
  });

  it('allows known provider env keys for equivalent official apiBase variants', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key';
    const p = getProvider('anthropic', { apiBase: 'https://api.anthropic.com/' });
    expect(p.name).toBe('anthropic');
  });

  it('allows local providers with custom apiBase when no env key is set', () => {
    delete process.env.OLLAMA_API_KEY;
    const p = getProvider('ollama', { apiBase: 'http://remote-ollama:11434/v1' });
    expect(p.name).toBe('ollama');
  });

  it('rejects local providers with env-sourced key and custom apiBase', () => {
    process.env.OLLAMA_API_KEY = 'ollama-real-key';
    expect(() => getProvider('ollama', { apiBase: 'http://remote-ollama:11434/v1' })).toThrow(
      /exfiltrat/i,
    );
  });

  it('allows known provider without apiBase override', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deep';
    const p = getProvider('deepseek');
    expect(p.name).toBe('deepseek');
  });
});

describe('detectCapabilities', () => {
  it('returns config contextLength for non-api implementer without throwing', async () => {
    const config = {
      implementer: {
        kind: 'cli' as const,
        tool: 'codex' as const,
        model: 'gpt-5.4-mini',
        contextLength: 32768,
      },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(32768);
    expect(result.origin).toBe('config');
  });

  it('returns default 8192 for non-api implementer without contextLength', async () => {
    const config = {
      implementer: { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5.4-mini' },
      planner: { kind: 'cli' as const, tool: 'claude-code' as const },
    } as Config;

    const result = await detectCapabilities(config);
    expect(result.contextLength).toBe(8192);
    expect(result.origin).toBe('fallback');
  });

  describe('api-kind precedence', () => {
    setupFetchMock();

    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env.DIPTYCH_CONTEXT_LENGTH;
      delete process.env.DIPTYCH_CONTEXT_LENGTH;
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.DIPTYCH_CONTEXT_LENGTH;
      else process.env.DIPTYCH_CONTEXT_LENGTH = savedEnv;
    });

    function ollamaConfig(contextLength?: number): Config {
      return {
        implementer: {
          kind: 'api' as const,
          provider: 'ollama' as const,
          apiBase: 'http://localhost:11434/v1',
          model: 'qwen:7b',
          ...(contextLength !== undefined ? { contextLength } : {}),
        },
        planner: { kind: 'cli' as const, tool: 'claude-code' as const },
      } as Config;
    }

    function mockDetectedContext(num: number): void {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ parameters: `num_ctx ${num}` }), { status: 200 }),
      );
    }

    it('env DIPTYCH_CONTEXT_LENGTH wins over provider detection', async () => {
      process.env.DIPTYCH_CONTEXT_LENGTH = '4096';
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig());

      expect(result.contextLength).toBe(4096);
      expect(result.origin).toBe('env');
    });

    it('explicit config contextLength wins over provider detection', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig(16384));

      expect(result.contextLength).toBe(16384);
      expect(result.origin).toBe('config');
    });

    it('falls back to provider detection when neither env nor config is set', async () => {
      mockDetectedContext(131072);

      const result = await detectCapabilities(ollamaConfig());

      expect(result.contextLength).toBe(131072);
      expect(result.origin).toBe('detected');
    });
  });
});

describe('detectAvailableProviders', () => {
  setupFetchMock();

  it('returns detection for each known provider', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }] }), { status: 200 });
      }
      throw new Error('refused');
    });

    const results = await detectAvailableProviders();
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({ available: true, models: [{ id: 'qwen:7b' }], isLocal: true });

    const deepseek = results.find((r) => r.provider === 'deepseek');
    expect(deepseek).toMatchObject({ available: false });
  });

  it('handles all providers failing', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles timeout', { timeout: 30000 }, async () => {
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise<Response>(() => {}));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});
