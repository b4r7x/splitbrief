import { describe, expect, it } from 'vitest';
import { getApiProviderDescriptor } from '../src/core/providers/api-provider-catalog.js';
import { getKnownProviderBaseURL } from '../src/core/providers/catalog.js';
import { ConfigSchema } from '../src/core/schemas/config.js';
import { resolveEvalConnection } from './connection.js';

describe('eval connection resolution', () => {
  it('fills an empty base URL from the provider catalog', () => {
    const resolved = resolveEvalConnection({
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });

    expect(resolved.baseUrl).toBe(getKnownProviderBaseURL('openai'));
  });

  it('keeps an explicitly given base URL instead of filling from the catalog', () => {
    const resolved = resolveEvalConnection({
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      apiKey: '',
      replay: true,
    });

    expect(resolved.baseUrl).toBe('https://api.example.test/v1');
  });

  it('fills a prefix-correct placeholder credential in replay mode so admission is not blocked', () => {
    for (const provider of ['openai', 'groq', 'anthropic']) {
      const prefix = getApiProviderDescriptor(provider)?.credentialPrefix;
      expect(prefix).toBeTruthy();
      const resolved = resolveEvalConnection({ provider, baseUrl: '', apiKey: '', replay: true });
      expect(resolved.apiKey).toBe(`${prefix}eval-replay`);
    }

    const noPrefix = resolveEvalConnection({
      provider: 'together',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });
    expect(noPrefix.apiKey).toBe('eval-replay');
  });

  it('fills a loopback provider with a credential the config schema accepts, inventing none', () => {
    const ollama = resolveEvalConnection({
      provider: 'ollama',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });
    const lmStudio = resolveEvalConnection({
      provider: 'lm-studio',
      baseUrl: '',
      apiKey: '',
      replay: true,
    });

    const ollamaParsed = ConfigSchema.safeParse(localImplementerConfig('ollama', ollama));
    const lmStudioParsed = ConfigSchema.safeParse(localImplementerConfig('lm-studio', lmStudio));

    expect(ollamaParsed.error).toBeUndefined();
    expect(lmStudioParsed.error).toBeUndefined();
    expect(lmStudio.apiKey).toBe('');
  });

  it('requires a real credential outside replay mode', () => {
    expect(() =>
      resolveEvalConnection({ provider: 'openai', baseUrl: '', apiKey: '', replay: false }),
    ).toThrow(expect.objectContaining({ kind: 'eval-api-key-required' }));
  });

  it('reports a provider without a default endpoint instead of guessing', () => {
    expect(() =>
      resolveEvalConnection({ provider: 'not-a-provider', baseUrl: '', apiKey: '', replay: true }),
    ).toThrow(expect.objectContaining({ kind: 'eval-provider-no-default-endpoint' }));
  });
});

function localImplementerConfig(
  provider: 'ollama' | 'lm-studio',
  connection: { baseUrl: string; apiKey: string },
) {
  return {
    version: 3,
    planner: {
      kind: 'api',
      provider: 'openai',
      service: 'openai',
      offering: 'payg',
      apiBase: 'https://api.example.test/v1',
      model: 'planner-model',
      apiKey: 'secret',
    },
    implementer: {
      kind: 'api',
      provider,
      service: provider,
      offering: 'local',
      apiBase: connection.baseUrl,
      model: 'local-model',
      apiKey: connection.apiKey,
    },
    validation: { typecheck: true, lint: false, test: true, testCommand: 'npm test' },
    workflow: { maxRetries: 1, mode: 'quick', persistTranscript: true },
  };
}
