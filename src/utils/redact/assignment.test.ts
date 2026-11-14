import { describe, expect, it } from 'vitest';
import { isCredentialEnvironmentName } from './assignment.js';

describe('isCredentialEnvironmentName', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GH_TOKEN',
    'KEY',
    'SESSION_AUTH',
    'AUTHORIZATION',
    'npm_config_token',
    'MY_PASSWORD_FILE',
    'CLIENTSECRET',
    'AUTHTOKEN',
    'PRIVATETOKEN',
    'CLIENTTOKEN',
  ])('treats %s as credential-bearing', (name) => {
    expect(isCredentialEnvironmentName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'TERM', 'KEYBOARD_LAYOUT', 'MONKEY', 'AUTHOR'])(
    'leaves %s alone',
    (name) => {
      expect(isCredentialEnvironmentName(name)).toBe(false);
    },
  );
});
