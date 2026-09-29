import { describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { apiKeyErrors } from './credentials.js';

describe('apiKeyErrors — kind-aware intermediate provider', () => {
  it('does not resolve a CLI-named intermediate provider through the CLI catalog', () => {
    const config = makeNoValidationConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        apiBase: 'https://my-endpoint.example/v1',
        apiKey: 'sk-inline',
        model: 'qwen',
      },
      escalation: {
        enabled: true,
        intermediateProvider: 'opencode',
        intermediateModel: 'gpt-5',
      },
    });

    expect(apiKeyErrors(config)).toEqual([]);
  });

  it('keeps the fallback credential on the implementer boundary, not the CLI name', () => {
    const config = makeNoValidationConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        apiBase: 'https://my-endpoint.example/v1',
        model: 'qwen',
      },
      escalation: {
        enabled: true,
        intermediateProvider: 'opencode',
        intermediateModel: 'gpt-5',
      },
    });
    const errors = apiKeyErrors(config);

    expect(errors).toContainEqual(
      expect.objectContaining({
        path: 'implementer.apiKey',
        message: expect.stringContaining('Custom provider custom-endpoint'),
      }),
    );
    expect(errors.some((error) => error.path.startsWith('escalation.'))).toBe(false);
  });
});
