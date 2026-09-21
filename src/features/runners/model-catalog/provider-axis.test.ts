import { describe, expect, it } from 'vitest';
import type { CliProviderAuthFact } from '../../../core/discovery/detection.js';
import {
  findProviderCredentialFact,
  providerFactMatchesAuthKey,
  resolveProviderAuthState,
} from './provider-axis.js';

const ZEN: CliProviderAuthFact = { provider: 'OpenCode', source: 'api' };
const GO: CliProviderAuthFact = { provider: 'OpenCode Go', source: 'api' };
const GO_ENV: CliProviderAuthFact = {
  provider: 'OpenCode Go',
  source: 'env',
  envVar: 'OPENCODE_GO_API_KEY',
};
const ZEN_ENV: CliProviderAuthFact = {
  provider: 'OpenCode',
  source: 'env',
  envVar: 'OPENCODE_API_KEY',
};

describe('credential-to-provider assignment', () => {
  it('backs exactly its own identity in both directions', () => {
    expect(providerFactMatchesAuthKey(GO, 'opencode-go')).toBe(true);
    expect(providerFactMatchesAuthKey(ZEN, 'opencode')).toBe(true);
  });

  it('never lets an OpenCode Go credential authenticate opencode', () => {
    expect(providerFactMatchesAuthKey(GO, 'opencode')).toBe(false);
    expect(findProviderCredentialFact('opencode', [GO])).toBeUndefined();
    expect(resolveProviderAuthState('opencode', [GO])).toBe('needs-signin');
  });

  it('never lets an OpenCode credential authenticate opencode-go', () => {
    expect(providerFactMatchesAuthKey(ZEN, 'opencode-go')).toBe(false);
    expect(findProviderCredentialFact('opencode-go', [ZEN])).toBeUndefined();
    expect(resolveProviderAuthState('opencode-go', [ZEN])).toBe('needs-signin');
  });

  it('holds env facts to the same exact identity in both directions', () => {
    expect(providerFactMatchesAuthKey(GO_ENV, 'opencode-go')).toBe(true);
    expect(providerFactMatchesAuthKey(ZEN_ENV, 'opencode')).toBe(true);
    expect(providerFactMatchesAuthKey(GO_ENV, 'opencode')).toBe(false);
    expect(providerFactMatchesAuthKey(ZEN_ENV, 'opencode-go')).toBe(false);
  });

  it('backs the documented aliases: Alibaba Coding Plan to alibaba, GitHub Copilot to github-copilot', () => {
    expect(
      providerFactMatchesAuthKey({ provider: 'Alibaba Coding Plan', source: 'api' }, 'alibaba'),
    ).toBe(true);
    expect(
      providerFactMatchesAuthKey({ provider: 'GitHub Copilot', source: 'oauth' }, 'github-copilot'),
    ).toBe(true);
    expect(
      providerFactMatchesAuthKey({ provider: 'GitHub Copilot', source: 'oauth' }, 'copilot'),
    ).toBe(false);
  });

  it('rejects arbitrary shared prefixes between unrelated identities', () => {
    expect(providerFactMatchesAuthKey(GO, 'open')).toBe(false);
    expect(providerFactMatchesAuthKey(GO, 'open-code')).toBe(false);
    expect(providerFactMatchesAuthKey({ provider: 'Ollama Cloud', source: 'api' }, 'ollama')).toBe(
      false,
    );
  });

  it('rejects env stems that merely share a prefix with the id segment', () => {
    expect(
      providerFactMatchesAuthKey(
        { provider: 'OpenRouter Free', source: 'env', envVar: 'OPENROUTER_FREE_API_KEY' },
        'openrouter',
      ),
    ).toBe(false);
    expect(
      providerFactMatchesAuthKey(
        { provider: 'Kimi For Coding', source: 'env', envVar: 'KIMI_API_KEY' },
        'kimi',
      ),
    ).toBe(true);
  });

  it('lets an unknown identity contribute no authentication claim about another provider', () => {
    const unknown: CliProviderAuthFact = { provider: 'Some Future Vendor', source: 'api' };
    expect(providerFactMatchesAuthKey(unknown, 'opencode')).toBe(false);
    expect(providerFactMatchesAuthKey(unknown, 'some-future-vendor')).toBe(true);
    expect(resolveProviderAuthState('some', [unknown])).toBe('needs-signin');
  });
});
