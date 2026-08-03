import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  API_PROVIDER_VERDICT_CANDIDATE_PATHS,
  ADMITTED_API_PROVIDER_IDS,
  PASS_API_PROVIDER_IDS,
} from '../../core/providers/api-provider-catalog.js';
import { resolveRepoPath as productionResolveRepoPath } from '../../core/runners/candidate-admission.js';
import {
  KNOWN_PROVIDERS,
  REGISTRY_OMIT_CANDIDATE_IDS,
  REGISTRY_PASS_CANDIDATE_IDS,
  REGISTRY_PASS_CANDIDATE_WIRING_COUNT,
  detectProviderCatalog,
  getProvider,
  detectAvailableProviders,
  providerDetectionFromOutcome,
} from './registry.js';
import { PROVIDER_CATALOG_FAILURE_KINDS } from './types.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

function resolveRepoPath(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetchRoutes(
  routes: Readonly<Record<string, unknown>>,
  fallback: () => Response = () => new Response('', { status: 404 }),
): void {
  vi.mocked(globalThis.fetch).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [needle, body] of Object.entries(routes)) {
      if (urlStr.includes(needle)) return jsonResponse(body);
    }
    return fallback();
  });
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
    expect([...REGISTRY_PASS_CANDIDATE_IDS]).toEqual([...PASS_API_PROVIDER_IDS]);
    const expectedOmitIds = API_PROVIDER_VERDICT_CANDIDATE_PATHS.map((entry) => entry.id).filter(
      (id) => !(PASS_API_PROVIDER_IDS as readonly string[]).includes(id),
    );
    expect([...REGISTRY_OMIT_CANDIDATE_IDS]).toEqual(expectedOmitIds);

    for (const id of REGISTRY_OMIT_CANDIDATE_IDS) {
      expect(KNOWN_PROVIDERS).not.toHaveProperty(id);
    }
    for (const candidate of API_PROVIDER_VERDICT_CANDIDATE_PATHS) {
      if ((PASS_API_PROVIDER_IDS as readonly string[]).includes(candidate.id)) continue;
      expect(existsSync(resolveRepoPath(candidate.source))).toBe(false);
      expect(existsSync(resolveRepoPath(candidate.test))).toBe(false);
    }
  });

  it('statically imports each PASS candidate once and wires createUnregisteredOpenAICompatProvider', () => {
    expect(REGISTRY_PASS_CANDIDATE_WIRING_COUNT).toBe(PASS_API_PROVIDER_IDS.length);

    const source = readFileSync(join(import.meta.dirname, 'registry.ts'), 'utf8');
    const candidateImports = source.match(/from '\.\/(?:candidates\/[^']+|llama-cpp)\.js'/g) ?? [];
    expect(candidateImports.length).toBe(PASS_API_PROVIDER_IDS.length);

    for (const id of PASS_API_PROVIDER_IDS) {
      const entry = API_PROVIDER_VERDICT_CANDIDATE_PATHS.find((candidate) => candidate.id === id);
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      const importPath = entry.source
        .replace(/^src\/engine\/providers\//, './')
        .replace(/\.ts$/, '.js');
      expect(source).toContain(`from '${importPath}'`);
      expect(source).toContain(`${entry.id}:`);
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

describe('detectAvailableProviders', () => {
  setupFetchMock();

  it('returns results for ollama and lm-studio', async () => {
    mockFetchRoutes({
      '11434': { models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3:8b' }] },
      '1234': { models: [{ key: 'deepseek-coder-v2', type: 'llm' }] },
    });

    const results = await detectAvailableProviders();
    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({
      available: true,
      models: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3:8b' }],
    });
    expect(ollama).not.toHaveProperty('failure');

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    expect(lmStudio).toMatchObject({ available: true, models: [{ id: 'deepseek-coder-v2' }] });
  });

  it('handles ollama running but lm-studio not running', async () => {
    mockFetchRoutes({ '11434': { models: [{ name: 'codellama:7b' }] } }, () => {
      throw new Error('Connection refused');
    });

    const results = await detectAvailableProviders();
    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    expect(ollama).toMatchObject({ available: true, models: [{ id: 'codellama:7b' }] });
    expect(lmStudio).toMatchObject({
      available: false,
      failure: 'offline',
      error: 'Connection refused',
    });
    expect(lmStudio).not.toHaveProperty('models');
  });

  it('returns detection for each known provider', async () => {
    mockFetchRoutes({ '11434': { models: [{ name: 'qwen:7b' }] } }, () => {
      throw new Error('refused');
    });

    const results = await detectAvailableProviders();
    expect(results.length).toBe(Object.keys(KNOWN_PROVIDERS).length);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({ available: true, models: [{ id: 'qwen:7b' }], isLocal: true });

    const deepseek = results.find((r) => r.provider === 'deepseek');
    expect(deepseek).toMatchObject({ available: false });
  });

  it('keeps successful metadata and valid empty inventories distinct', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: 'qwen3-coder:30b', details: { family: 'qwen3' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ models: [] }));

    const populated = await detectProviderCatalog({ provider: 'ollama' });
    const empty = await detectProviderCatalog({ provider: 'ollama' });

    expect(populated).toMatchObject({
      kind: 'success',
      source: 'provider-runtime',
      provider: 'ollama',
      catalog: 'populated',
      models: [{ id: 'qwen3-coder:30b', providerId: 'ollama', capabilities: ['family:qwen3'] }],
    });
    expect(empty).toEqual({
      kind: 'success',
      source: 'provider-runtime',
      provider: 'ollama',
      isLocal: true,
      credential: 'not-required',
      catalog: 'empty',
      models: [],
    });
  });

  it('projects a valid empty inventory as reachable rather than a failed discovery', async () => {
    mockFetchRoutes({ '11434': { models: [] }, '1234': { models: [] } });

    const results = await detectAvailableProviders();
    expect(results.find((result) => result.provider === 'ollama')).toEqual({
      provider: 'ollama',
      available: true,
      isLocal: true,
      models: [],
    });
  });

  it('classifies exact sanitized HTTP 403 as policy denial instead of valid empty', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('', { status: 403 }));

    const outcome = await detectProviderCatalog({
      provider: 'openai',
      configOverrides: { apiKey: 'sk-registry-policy-denied' },
    });

    expect(outcome).toEqual({
      kind: 'failed',
      source: 'provider-runtime',
      provider: 'openai',
      isLocal: false,
      credential: 'present',
      failure: 'policy-denied',
      diagnostic: 'HTTP 403',
    });
  });

  it.each([
    ['privacy_data_collection_restricted', 'privacy-filtered'],
    ['guardrail_rejected', 'guardrail-filtered'],
  ] as const)('preserves OpenRouter %s as a typed %s catalog failure', async (code, failure) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code } }), { status: 403 }),
    );

    const outcome = await detectProviderCatalog({
      provider: 'openrouter',
      configOverrides: { apiKey: 'sk-or-filtered' },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openrouter',
      failure,
    });
  });

  it('validates a configured endpoint before attempting its credential reference', async () => {
    const outcome = await detectProviderCatalog({
      provider: 'openrouter',
      configOverrides: {
        apiBase: 'https://untrusted.example/api/v1',
        apiKey: 'env:REGISTRY_MISSING_KEY',
      },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openrouter',
      failure: 'endpoint-invalid',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('handles all providers failing', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('refused'));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('redacts configured credentials from typed catalog failures', async () => {
    const canary = 'sk-canary-registry-credential-6e2a';
    vi.mocked(globalThis.fetch).mockRejectedValue(
      new Error(`upstream Authorization: Bearer ${canary}`),
    );

    const outcome = await detectProviderCatalog({
      provider: 'openai',
      configOverrides: { apiKey: canary },
    });

    expect(outcome).toMatchObject({
      kind: 'failed',
      provider: 'openai',
      credential: 'present',
      diagnostic: expect.stringContaining('***REDACTED***'),
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });

  it('handles timeout', { timeout: 30000 }, async () => {
    vi.mocked(globalThis.fetch).mockReturnValue(new Promise<Response>(() => {}));

    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});

describe('providerDetectionFromOutcome', () => {
  it.each(PROVIDER_CATALOG_FAILURE_KINDS)('carries a %s failure into the detection', (failure) => {
    expect(
      providerDetectionFromOutcome({
        kind: 'failed',
        source: 'provider-runtime',
        provider: 'openai',
        isLocal: false,
        credential: 'present',
        failure,
        diagnostic: 'diagnostic under test',
      }),
    ).toEqual({
      provider: 'openai',
      available: false,
      isLocal: false,
      hasKey: true,
      failure,
      error: 'diagnostic under test',
    });
  });
});
