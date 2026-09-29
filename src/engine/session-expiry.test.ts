import { describe, it, expect } from 'vitest';
import { isSessionExpiredError, createSessionResumeState } from './session-expiry.js';

describe('isSessionExpiredError', () => {
  const EXPIRED_MESSAGES = [
    'Error: session not found',
    'API error: session_not_found',
    'invalid session ID provided',
    'Expired session: abc-123',
    'server returned: no such session',
    'could not resume: stream closed',
    'session: failed to load thread-abc',
    'thread not loaded: thread-abc',
    // codex-cli 0.157.1 `exec resume` of a thread whose rollout file is gone (captured live).
    'Error: thread/resume: thread/resume failed: no rollout found for thread id 01a0ebc7-6363-7ac0-bb5f-95ddd418e55c (code -32600)',
    // Claude Code 2.1.284 `--resume` of a session it does not hold (captured live).
    'claude exited with code 1: No conversation found with session ID: 00000000-0000-4000-8000-000000000000',
  ];

  it.each(EXPIRED_MESSAGES)('matches expired-session variant: %s', (msg) => {
    expect(isSessionExpiredError(new Error(msg))).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSessionExpiredError(new Error('SESSION NOT FOUND'))).toBe(true);
    expect(isSessionExpiredError(new Error('Invalid Session'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSessionExpiredError(new Error('network timeout'))).toBe(false);
    expect(isSessionExpiredError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('handles non-Error inputs (string, null, undefined)', () => {
    expect(isSessionExpiredError('session not found')).toBe(true);
    expect(isSessionExpiredError('nothing to see here')).toBe(false);
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});

describe('createSessionResumeState', () => {
  it('starts with no session and can capture / clear it', () => {
    const state = createSessionResumeState();
    expect(state.getResumeId()).toBeNull();

    state.capture('abc-123');
    expect(state.getResumeId()).toBe('abc-123');

    state.capture(null);
    expect(state.getResumeId()).toBeNull();
  });
});
