import { describe, it, expect } from 'vitest';
import type { CliAuthChannel } from '../../../core/runners/cli-tool/auth-channels.js';
import { defaultCliAuthChannel } from '../../../core/runners/cli-tool/catalog.js';
import { cliAuthChannelEnvKeys } from './auth-env.js';

function authChannel(over: Partial<CliAuthChannel>): CliAuthChannel {
  return {
    id: 'session',
    env: [],
    billing: 'subscription-included',
    hostKeychainPlatforms: [],
    ...over,
  };
}

describe('cliAuthChannelEnvKeys', () => {
  it('uses the credential staging policy when billing and the channel disagree', () => {
    const processEnv = { OLLAMA_API_KEY: 'k', PATH: '/bin' };
    const provider = defaultCliAuthChannel('opencode');
    const session = defaultCliAuthChannel('codex');

    expect(
      cliAuthChannelEnvKeys({ ...provider, billing: 'subscription-included' }, processEnv),
    ).toContain('OLLAMA_API_KEY');
    expect(
      cliAuthChannelEnvKeys({ ...session, billing: 'provider-dependent' }, processEnv),
    ).toEqual([...session.env]);
  });

  it('passes every provider API key to a provider-dependent tool', () => {
    expect(
      cliAuthChannelEnvKeys(
        authChannel({ id: 'provider-dependent', billing: 'provider-dependent' }),
        { OLLAMA_API_KEY: 'k', KIMI_API_KEY: 'k', PATH: '/bin', HOME: '/h' },
      ),
    ).toEqual(['OLLAMA_API_KEY', 'KIMI_API_KEY']);
  });

  it('keeps a session channel to the keys it declares', () => {
    expect(
      cliAuthChannelEnvKeys(authChannel({ env: ['COPILOT_GITHUB_TOKEN'] }), {
        OLLAMA_API_KEY: 'k',
        COPILOT_GITHUB_TOKEN: 'g',
      }),
    ).toEqual(['COPILOT_GITHUB_TOKEN']);
  });

  it('leaves a subscription session channel scrubbed', () => {
    expect(cliAuthChannelEnvKeys(authChannel({}), { OLLAMA_API_KEY: 'k' })).toEqual([]);
  });

  it('preserves nothing when the channel is undefined', () => {
    expect(cliAuthChannelEnvKeys(undefined, { OLLAMA_API_KEY: 'k' })).toEqual([]);
  });

  it('lists a declared key of a provider-dependent channel exactly once', () => {
    expect(
      cliAuthChannelEnvKeys(
        authChannel({
          id: 'provider-dependent',
          env: ['OPENCODE_API_KEY'],
          billing: 'provider-dependent',
        }),
        { OPENCODE_API_KEY: 'x', OLLAMA_API_KEY: 'y' },
      ),
    ).toEqual(['OPENCODE_API_KEY', 'OLLAMA_API_KEY']);
  });
});
