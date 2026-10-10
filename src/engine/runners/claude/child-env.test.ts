import { describe, expect, it } from 'vitest';
import { SANDBOX_CREDENTIAL_VALUES } from '../sandbox-credential-values.js';
import { claudeCredentialValues } from './child-env.js';

describe('claudeCredentialValues', () => {
  it.each(['api-key', 'session', undefined] as const)(
    'selects the admitted credentials for %s authentication',
    (authChannel) => {
      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'opaque-api-credential' };
      Object.defineProperty(env, SANDBOX_CREDENTIAL_VALUES, {
        value: ['opaque-session-credential'],
      });

      expect(claudeCredentialValues(authChannel, env)).toEqual(
        authChannel === 'api-key'
          ? ['opaque-api-credential', 'opaque-session-credential']
          : ['opaque-session-credential'],
      );
    },
  );

  it('has no credential values when the selected key and sandbox state are absent', () => {
    expect(claudeCredentialValues('api-key', {})).toEqual([]);
  });
});
