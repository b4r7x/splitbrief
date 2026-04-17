import { describe, expect, it } from 'vitest';
import { redactSecrets, maskApiKey } from './redact.js';

describe('redactSecrets', () => {
  it('redacts Anthropic-style keys', () => {
    const msg = 'Error: invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Error: invalid key sk-ant-***REDACTED***');
  });

  it('redacts OpenAI-style keys', () => {
    const msg = 'Auth failed with sk-proj-abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(msg)).toBe('Auth failed with sk-***REDACTED***');
  });

  it('redacts Bearer tokens', () => {
    const msg = 'Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    expect(redactSecrets(msg)).toBe('Header: Bearer ***REDACTED***');
  });

  it('redacts Groq-style keys', () => {
    const msg = 'Error with gsk_abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Error with gsk_***REDACTED***');
  });

  it('redacts xAI-style keys', () => {
    const msg = 'Failed: xai-abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Failed: xai-***REDACTED***');
  });

  it('redacts GitHub personal access tokens', () => {
    const msg = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    expect(redactSecrets(msg)).toBe('token: ghp_***REDACTED***');
  });

  it('redacts GitHub OAuth tokens (gho_)', () => {
    const msg = 'token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    expect(redactSecrets(msg)).toBe('token: gho_***REDACTED***');
  });

  it('redacts GitHub fine-grained PATs (github_pat_)', () => {
    const msg = 'token: github_pat_ABCDEFGHIJKLMNOPQRSTUV22';
    expect(redactSecrets(msg)).toBe('token: github_pat_***REDACTED***');
  });

  it('redacts AWS access key IDs', () => {
    const msg = 'aws_key: AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(msg)).toBe('aws_key: AKIA***REDACTED***');
  });

  it('handles multiple keys in one string', () => {
    const msg = 'key1=sk-ant-api03-aaaabbbbccccddddeeeefffff key2=sk-proj-xxxxyyyyzzzzaaaabbbbcccc';
    const result = redactSecrets(msg);
    expect(result).not.toContain('aaaabbbbccccddddeeeefffff');
    expect(result).not.toContain('xxxxyyyyzzzzaaaabbbbcccc');
    expect(result).toContain('sk-ant-***REDACTED***');
    expect(result).toContain('sk-***REDACTED***');
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('does not redact git commit SHAs', () => {
    const msg = 'commit abc123def456789012345678901234567890abcd';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('does not redact short strings below the redaction threshold', () => {
    const msg = 'Error: key sk-short is invalid';
    expect(redactSecrets(msg)).toBe('Error: key sk-short is invalid');
  });
});

describe('maskApiKey', () => {
  it('masks long keys showing last 4 chars', () => {
    expect(maskApiKey('sk-ant-api03-abcdef1234')).toBe('••••1234');
  });

  it('returns empty string for undefined or empty input', () => {
    expect(maskApiKey(undefined)).toBe('');
    expect(maskApiKey('')).toBe('');
  });
});
