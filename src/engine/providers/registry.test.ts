import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  ADMITTED_API_PROVIDER_IDS,
} from '../../core/providers/api-provider-catalog.js';
import { FORBIDDEN_API_PROVIDER_IDS } from '../../core/providers/api-provider-verdicts.js';
import { KNOWN_PROVIDERS, getProvider } from './registry.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('provider registry admission', () => {
  it('registers exactly the retained factories and matches the catalog', () => {
    expect(Object.keys(KNOWN_PROVIDERS).toSorted()).toEqual(['lm-studio', 'ollama']);
    expect(Object.keys(KNOWN_PROVIDERS).toSorted()).toEqual(
      Object.keys(API_PROVIDER_CATALOG).toSorted(),
    );
  });

  it('keeps every forbidden provider id out of the registry', () => {
    for (const id of FORBIDDEN_API_PROVIDER_IDS) {
      expect(KNOWN_PROVIDERS).not.toHaveProperty(id);
    }
  });

  it('wires a factory for every catalog id', () => {
    for (const id of ADMITTED_API_PROVIDER_IDS) {
      expect(typeof KNOWN_PROVIDERS[id]).toBe('function');
    }
  });
});

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

  it('returns the admitted local provider for a known name', () => {
    const p = getProvider('lm-studio');
    expect(p.name).toBe('lm-studio');
    expect(p.baseURL).toBe('http://localhost:1234/v1');
    expect(typeof p.apiKey()).toBe('string');
  });

  it('keeps local Ollama on its loopback endpoint and rejects foreign credentials', () => {
    expect(getProvider('ollama')).toMatchObject({
      name: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      isLocal: true,
    });
    expect(() => getProvider('ollama', { apiKey: 'env:OLLAMA_API_KEY' })).toThrow(
      expect.objectContaining({ kind: 'provider-ollama-local-credential-invalid' }),
    );
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

  it('lists models from the admitted local provider', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ models: [{ key: 'qwen2.5-coder-7b', type: 'llm' }] }),
    );

    const provider = getProvider('lm-studio');
    const models = await provider.listModels();

    expect(models).toEqual(['qwen2.5-coder-7b']);
  });
});

describe('apiKey env references', () => {
  it('resolves env: apiKey overrides for known providers', () => {
    process.env.LM_STUDIO_API_KEY = 'lms-env-key';
    const p = getProvider('lm-studio', { apiKey: 'env:LM_STUDIO_API_KEY' });
    expect(p.apiKey()).toBe('lms-env-key');
  });

  it('throws when an env: apiKey override references a missing variable', () => {
    delete process.env.LM_STUDIO_API_KEY;
    expect(() => getProvider('lm-studio', { apiKey: 'env:LM_STUDIO_API_KEY' })).toThrow(
      /LM_STUDIO_API_KEY/,
    );
  });

  it('throws when an env: apiKey override has an empty variable name', () => {
    expect(() => getProvider('lm-studio', { apiKey: 'env:' })).toThrow(/env:VARIABLE_NAME/);
  });

  it('throws when an env: apiKey override has a whitespace-only variable name', () => {
    expect(() => getProvider('lm-studio', { apiKey: 'env:   ' })).toThrow(/env:VARIABLE_NAME/);
  });

  it('rejects env-referenced keys with a custom apiBase for known providers', () => {
    process.env.LM_STUDIO_API_KEY = 'lms-env-key';
    expect(() =>
      getProvider('lm-studio', {
        apiBase: 'https://proxy.example.com/v1',
        apiKey: 'env:LM_STUDIO_API_KEY',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('validates a known provider endpoint before resolving an env key reference', () => {
    delete process.env.LM_STUDIO_API_KEY;
    expect(() =>
      getProvider('lm-studio', {
        apiBase: 'https://evil.example.com/api/v1',
        apiKey: 'env:LM_STUDIO_API_KEY',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });
});

describe('known provider endpoint policies', () => {
  setupFetchMock();

  it('rejects a known provider pointed off its declared endpoint', () => {
    expect(() => getProvider('lm-studio', { apiBase: 'https://evil.example.com/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
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
    const p = getProvider('lm-studio', { apiBase: 'http://localhost:1234/v1' });
    expect(p.name).toBe('lm-studio');
  });

  it('allows and normalizes loopback provider overrides', () => {
    delete process.env.OLLAMA_API_KEY;
    const p = getProvider('ollama', { apiBase: 'http://127.0.0.1:22000' });
    expect(p.name).toBe('ollama');
    expect(p.baseURL).toBe('http://127.0.0.1:22000/v1');
  });

  it('rejects non-loopback local provider overrides before resolving credentials', () => {
    process.env.OLLAMA_API_KEY = 'ollama-real-key';
    expect(() => getProvider('ollama', { apiBase: 'http://remote-ollama:11434/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('allows known provider without apiBase override', () => {
    const p = getProvider('lm-studio');
    expect(p.name).toBe('lm-studio');
  });
});
