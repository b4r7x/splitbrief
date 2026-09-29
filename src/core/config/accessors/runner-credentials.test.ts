import { describe, expect, it } from 'vitest';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import { missingRunnerCredential } from './runner-credentials.js';

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

describe('missingRunnerCredential', () => {
  it('requires a key for a CLI-named custom API provider instead of reading a CLI catalog entry', () => {
    expect(missingRunnerCredential(cliNamedCustom())).toEqual({
      provider: 'opencode',
      providerDisplayName: 'Custom provider opencode',
    });
    expect(missingRunnerCredential(cliNamedCustom('sk-inline'))).toBeUndefined();
  });

  it('keeps a catalogued API provider and a CLI runner on their own rules', () => {
    const ollama: ImplementerConfig = {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'qwen',
    };
    expect(missingRunnerCredential(ollama)).toBeUndefined();

    const cli: ImplementerConfig = { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5' };
    expect(missingRunnerCredential(cli)).toBeUndefined();
  });
});
