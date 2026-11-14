import { describe, expect, it } from 'vitest';
import { cliProviderAuthFacts, normalizeProviderAuth } from './auth.js';

describe('detection schemas', () => {
  it('normalizes a stored provider-auth payload of any vintage', () => {
    const facts = [{ provider: 'OpenAI', source: 'oauth' as const }];

    expect(normalizeProviderAuth({ tool: 'opencode', providerAuth: facts })).toEqual({
      kind: 'read',
      facts,
    });
    expect(normalizeProviderAuth({ tool: 'opencode', providerAuth: [] })).toEqual({
      kind: 'empty',
    });
    expect(normalizeProviderAuth({ tool: 'opencode', providerAuth: { kind: 'empty' } })).toEqual({
      kind: 'empty',
    });
    for (const tool of ['opencode', 'kilo-code'] as const) {
      expect(normalizeProviderAuth({ tool, providerAuth: undefined })).toEqual({
        kind: 'unreadable',
        reason: 'not-probed',
      });
    }
    expect(normalizeProviderAuth({ tool: 'codex', providerAuth: undefined })).toBeUndefined();
  });

  it('counts an empty listing as zero facts and an unreadable one as nothing', () => {
    const facts = [{ provider: 'OpenAI', source: 'oauth' as const }];

    expect(cliProviderAuthFacts({ kind: 'read', facts })).toEqual(facts);
    expect(cliProviderAuthFacts({ kind: 'empty' })).toEqual([]);
    expect(cliProviderAuthFacts({ kind: 'unreadable', reason: 'timeout' })).toBeUndefined();
    expect(cliProviderAuthFacts(undefined)).toBeUndefined();
  });
});
