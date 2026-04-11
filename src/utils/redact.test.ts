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

  it('redacts apiKey= patterns', () => {
    const msg = 'Request with apiKey=abcdef1234567890abcdef1234567890';
    expect(redactSecrets(msg)).toBe('Request with apiKey=***REDACTED***');
  });

  it('redacts api_key= patterns', () => {
    const msg = 'Config: api_key="sk_live_abcdefghijklmnopqrstuv"';
    expect(redactSecrets(msg)).toBe('Config: api_key="***REDACTED***"');
  });

  it('redacts token= patterns', () => {
    const msg = 'token=abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(msg)).toBe('token=***REDACTED***');
  });

  it('redacts secret: patterns', () => {
    const msg = 'secret: abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(msg)).toBe('secret: ***REDACTED***');
  });

  it('redacts OpenRouter-style keys', () => {
    const msg = 'Auth failed with sk-or-v1-abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(msg)).toBe('Auth failed with sk-or-***REDACTED***');
  });

  it('redacts Groq-style keys', () => {
    const msg = 'Error with gsk_abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Error with gsk_***REDACTED***');
  });

  it('redacts xAI-style keys', () => {
    const msg = 'Failed: xai-abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Failed: xai-***REDACTED***');
  });

  it('redacts GLHF-style keys', () => {
    const msg = 'Auth: glhf_abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSecrets(msg)).toBe('Auth: glhf_***REDACTED***');
  });

  it('redacts Google AI keys', () => {
    const msg = 'Key: AIzaSyAbcdefghijklmnopqrstuvw';
    expect(redactSecrets(msg)).toBe('Key: AIza***REDACTED***');
  });

  it('does not redact git commit SHAs', () => {
    const msg = 'commit abc123def456789012345678901234567890abcd';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('does not redact short strings', () => {
    const msg = 'Error: key sk-short is invalid';
    expect(redactSecrets(msg)).toBe('Error: key sk-short is invalid');
  });

  it('does not modify normal error messages', () => {
    const msg = 'Connection refused: ECONNREFUSED 127.0.0.1:11434';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('does not modify code snippets', () => {
    const msg = 'const x = await fetch(url);\nreturn response.json();';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('handles multiple keys in one string', () => {
    const msg = 'key1=sk-ant-api03-aaaabbbbccccddddeeeefffff key2=sk-proj-xxxxyyyyzzzzaaaabbbbcccc';
    const result = redactSecrets(msg);
    expect(result).not.toContain('aaaabbbbccccddddeeeefffff');
    expect(result).not.toContain('xxxxyyyyzzzzaaaabbbbcccc');
    expect(result).toContain('sk-ant-***REDACTED***');
    expect(result).toContain('sk-***REDACTED***');
  });

  it('returns original string if no keys found', () => {
    const msg = 'Everything is fine';
    expect(redactSecrets(msg)).toBe(msg);
  });

  it('redacts base64 tokens (20-39 chars with +/=) after keyword', () => {
    const msg = 'secret: abc+def/ghi=jklmnopqrstuvwx';
    expect(redactSecrets(msg)).toBe('secret: ***REDACTED***');
  });

  it('redacts generic long tokens after key= pattern', () => {
    const input = 'api_key=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    expect(redactSecrets(input)).toContain('***REDACTED***');
    expect(redactSecrets(input)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts x-api-key header values', () => {
    const input = 'x-api-key: abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    expect(redactSecrets(input)).toContain('***REDACTED***');
  });

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts credential= patterns', () => {
    const msg = 'credential=abcdefghijklmnopqrstuvwxyz';
    expect(redactSecrets(msg)).toContain('***REDACTED***');
    expect(redactSecrets(msg)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts password= patterns', () => {
    const msg = 'password=mysecretpassword1234567890';
    expect(redactSecrets(msg)).toContain('***REDACTED***');
    expect(redactSecrets(msg)).not.toContain('mysecretpassword1234567890');
  });

  it('redacts GitHub personal access tokens (ghp_)', () => {
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

  it('does not redact partial matches split across lines', () => {
    const msg = 'password=short\nnot_a_key';
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe('maskApiKey', () => {
  it('masks long keys showing last 4 chars', () => {
    expect(maskApiKey('sk-ant-api03-abcdef1234')).toBe('••••1234');
  });

  it('fully masks short keys', () => {
    expect(maskApiKey('short')).toBe('••••••••');
  });

  it('returns empty string for undefined', () => {
    expect(maskApiKey(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(maskApiKey('')).toBe('');
  });

  it('masks exactly 8-char keys showing last 4', () => {
    expect(maskApiKey('12345678')).toBe('••••5678');
  });
});
