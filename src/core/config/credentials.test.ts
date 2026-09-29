import { describe, expect, it } from 'vitest';
import type { ImplementerConfig } from '../schemas/implementer-config.js';
import {
  customEndpointCredentialSourceError,
  customProviderEnvApiKeyReferenceError,
} from './credentials.js';

/** A custom API provider whose name reuses a CLI tool id. */
function cliNamedCustom(apiKey?: string): ImplementerConfig {
  return {
    kind: 'api',
    provider: 'opencode',
    service: 'opencode',
    offering: 'payg',
    apiBase: 'https://my-endpoint.example/v1',
    model: 'gpt-5',
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

describe('custom provider credential guards', () => {
  it('refuses an env apiKey reference for a custom provider named after a CLI tool', () => {
    expect(
      customProviderEnvApiKeyReferenceError({
        role: 'implementer',
        path: 'implementer',
        config: cliNamedCustom('env:MY_KEY'),
      }),
    ).toEqual({
      path: 'implementer.apiKey',
      message: expect.stringContaining('Custom/unknown provider opencode'),
    });
  });

  it('leaves a catalogued API provider alone and accepts an inline custom key', () => {
    const catalogued: ImplementerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen',
      apiKey: 'env:SOME_UNSET_KEY',
    };

    expect(
      customProviderEnvApiKeyReferenceError({
        role: 'planner',
        path: 'planner',
        config: catalogued,
      }),
    ).toBeUndefined();
    expect(
      customProviderEnvApiKeyReferenceError({
        role: 'implementer',
        path: 'implementer',
        config: cliNamedCustom('sk-inline'),
      }),
    ).toBeUndefined();
  });

  it('never tests a custom provider against a CLI catalog entry', () => {
    expect(
      customEndpointCredentialSourceError({
        role: 'implementer',
        path: 'implementer',
        config: cliNamedCustom(),
      }),
    ).toBeUndefined();

    const cli: ImplementerConfig = { kind: 'cli', tool: 'claude-code', model: 'sonnet' };
    expect(
      customEndpointCredentialSourceError({ role: 'planner', path: 'planner', config: cli }),
    ).toBeUndefined();
  });
});
