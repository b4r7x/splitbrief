import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  ADMITTED_API_PROVIDER_IDS,
} from '../../core/providers/api-provider-catalog.js';
import {
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  PASS_API_PROVIDER_IDS,
} from '../../core/providers/api-provider-verdicts.js';
import { resolveRepoPath as productionResolveRepoPath } from '../../core/runners/candidate-admission.js';
import { KNOWN_PROVIDERS, REGISTRY_OMIT_CANDIDATE_IDS, getProvider } from './registry.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('provider registry admission', () => {
  it('resolves production repo root to the workspace package.json', () => {
    expect(existsSync(productionResolveRepoPath('package.json'))).toBe(true);
    expect(productionResolveRepoPath('package.json')).toBe(resolveRepoPath('package.json'));
  });

  it('matches catalog keys with the exact retained registry count', () => {
    expect(Object.keys(KNOWN_PROVIDERS).toSorted()).toEqual(
      Object.keys(API_PROVIDER_CATALOG).toSorted(),
    );
    expect(Object.keys(KNOWN_PROVIDERS).length).toBe(ADMITTED_API_PROVIDER_IDS.length);
  });

  it('derives the PASS allowlist from T-044–T-053 verdicts and keeps OMIT modules absent', () => {
    for (const id of REGISTRY_OMIT_CANDIDATE_IDS) {
      expect(KNOWN_PROVIDERS).not.toHaveProperty(id);
    }
    for (const candidate of API_PROVIDER_VERDICT_CANDIDATE_PATHS) {
      if ((PASS_API_PROVIDER_IDS as readonly string[]).includes(candidate.id)) continue;
      expect(existsSync(resolveRepoPath(candidate.source))).toBe(false);
      expect(existsSync(resolveRepoPath(candidate.test))).toBe(false);
    }
  });

  it('wires a factory for every catalog id', () => {
    for (const id of Object.keys(API_PROVIDER_CATALOG)) {
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

  it('returns valid provider for known openai-compat name (deepseek)', () => {
    const p = getProvider('deepseek');
    expect(p.name).toBe('deepseek');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(typeof p.apiKey()).toBe('string');
  });

  it('keeps local Ollama and Ollama Cloud as separate provider sources', () => {
    const local = getProvider('ollama');
    const cloud = getProvider('ollama-cloud', { apiKey: 'ollama-cloud-registry-key' });

    expect(local).toMatchObject({
      name: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      isLocal: true,
    });
    expect(cloud).toMatchObject({
      name: 'ollama-cloud',
      baseURL: 'https://ollama.com',
      isLocal: false,
    });
    expect(cloud.apiKey()).toBe('ollama-cloud-registry-key');
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

  it('lists Anthropic models with Anthropic headers', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ data: [{ id: 'claude-sonnet-4-6', created_at: '2025-02-19T00:00:00Z' }] }),
    );

    const provider = getProvider('anthropic', {
      apiBase: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
    });
    const models = await provider.listModels();

    expect(models).toEqual(['claude-sonnet-4-6']);
  });
});

describe('apiKey env references', () => {
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
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it('validates a known provider endpoint before resolving an env key reference', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() =>
      getProvider('openrouter', {
        apiBase: 'https://evil.example.com/api/v1',
        apiKey: 'env:OPENROUTER_API_KEY',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });
});

describe('known provider endpoint policies', () => {
  setupFetchMock();

  it('rejects known provider with env-sourced key and custom apiBase', () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    expect(() => getProvider('openai', { apiBase: 'https://evil.example.com/v1' })).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('rejects a fixed-origin override even with an inline apiKey', () => {
    delete process.env.OPENAI_API_KEY;
    expect(() =>
      getProvider('openai', {
        apiBase: 'https://proxy.example.com/v1',
        apiKey: 'sk-inline',
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
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

  it('normalizes equivalent exact fixed endpoints before provider construction', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key';
    const p = getProvider('anthropic', { apiBase: 'HTTPS://API.ANTHROPIC.COM:443/v1/' });
    expect(p.baseURL).toBe('https://api.anthropic.com/v1');
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
    process.env.DEEPSEEK_API_KEY = 'sk-deep';
    const p = getProvider('deepseek');
    expect(p.name).toBe('deepseek');
  });
});
