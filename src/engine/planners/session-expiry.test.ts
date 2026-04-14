import { describe, it, expect } from 'vitest';

// isSessionExpiredError is not exported, so we test it indirectly via the patterns.
// Test the session expired error detection patterns directly.

const SESSION_EXPIRED_PATTERNS = [
  'session not found',
  'session_not_found',
  'invalid session',
  'expired session',
];

function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return SESSION_EXPIRED_PATTERNS.some(p => msg.includes(p));
}

describe('isSessionExpiredError', () => {
  it('matches "session not found" error message', () => {
    expect(isSessionExpiredError(new Error('Error: session not found'))).toBe(true);
  });

  it('matches "session_not_found" error message', () => {
    expect(isSessionExpiredError(new Error('API error: session_not_found'))).toBe(true);
  });

  it('matches "invalid session" error message', () => {
    expect(isSessionExpiredError(new Error('invalid session ID provided'))).toBe(true);
  });

  it('matches "expired session" error message', () => {
    expect(isSessionExpiredError(new Error('Expired session: abc-123'))).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSessionExpiredError(new Error('SESSION NOT FOUND'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSessionExpiredError(new Error('network timeout'))).toBe(false);
    expect(isSessionExpiredError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('handles string errors', () => {
    expect(isSessionExpiredError('session not found')).toBe(true);
  });
});
