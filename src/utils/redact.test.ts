import { describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsWithMetadata } from './redact.js';

describe('redactSecrets', () => {
  it.each([
    [
      'Error: invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      'Error: invalid key sk-ant-***REDACTED***',
    ],
    ['Auth failed with sk-proj-abcdefghijklmnopqrstuvwxyz', 'Auth failed with sk-***REDACTED***'],
    [
      'Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      'Header: Bearer ***REDACTED***',
    ],
    ['Error with gsk_abcdefghijklmnopqrstuvwxyz123456', 'Error with gsk_***REDACTED***'],
    ['Failed: xai-abcdefghijklmnopqrstuvwxyz123456', 'Failed: xai-***REDACTED***'],
    ['token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: ghp_***REDACTED***'],
    ['token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'token: gho_***REDACTED***'],
    ['token: github_pat_ABCDEFGHIJKLMNOPQRSTUV22', 'token: github_pat_***REDACTED***'],
    ['aws_key: AKIAIOSFODNN7EXAMPLE', 'aws_key: AKIA***REDACTED***'],
    ['slack: xoxb-abcdefghijklmnop', 'slack: xoxb-***REDACTED***'],
    [
      'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'jwt: ***REDACTED***',
    ],
  ])('redacts known secret shapes', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('handles multiple keys in one string', () => {
    const msg = 'key1=sk-ant-api03-aaaabbbbccccddddeeeefffff key2=sk-proj-xxxxyyyyzzzzaaaabbbbcccc';
    const result = redactSecrets(msg);
    expect(result).not.toContain('aaaabbbbccccddddeeeefffff');
    expect(result).not.toContain('xxxxyyyyzzzzaaaabbbbcccc');
    expect(result).toContain('sk-ant-***REDACTED***');
    expect(result).toContain('sk-***REDACTED***');
  });

  it.each([
    '',
    'commit abc123def456789012345678901234567890abcd',
    'Error: key sk-short is invalid',
  ])('leaves non-secret text unchanged', (message) => {
    expect(redactSecrets(message)).toBe(message);
  });

  it('returns redaction metadata and supports a custom marker', () => {
    const result = redactSecretsWithMetadata('password="hunter2"', { marker: '[REDACTED]' });

    expect(result).toEqual({ text: 'password="[REDACTED]"', redacted: true });
  });

  it('reports metadata for bare JWT-like tokens through the shared policy', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactSecretsWithMetadata(`token=${jwt}`, { marker: '[SECRET]' });

    expect(result).toEqual({ text: 'token=[SECRET]', redacted: true });
  });

  it('redacts URL credentials and private keys through the shared policy', () => {
    const result = redactSecretsWithMetadata(
      [
        'postgres://user:password@example.com/app',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'secret-key-body',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
    );

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain('user:password@example.com');
    expect(result.text).not.toContain('secret-key-body');
  });
});
