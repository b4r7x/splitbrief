import { describe, it, expect, vi } from 'vitest';
import { isSessionExpiredError, createSessionResumeState } from './session-expiry.js';

describe('isSessionExpiredError', () => {
  const EXPIRED_MESSAGES = [
    'Error: session not found',
    'API error: session_not_found',
    'invalid session ID provided',
    'Expired session: abc-123',
    'server returned: no such session',
    'could not resume: stream closed',
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

  it('handleResumeError does nothing when there is no captured session', () => {
    const state = createSessionResumeState();
    expect(state.handleResumeError(new Error('session not found'))).toBe(false);
  });

  it('handleResumeError ignores non-session errors and preserves the captured id', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');

    expect(state.handleResumeError(new Error('network failed'))).toBe(false);
    expect(state.getResumeId()).toBe('abc-123');
  });

  it('handleResumeError clears the captured id and fires the callback on expired-session error', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });
    state.capture('abc-123');

    expect(state.handleResumeError(new Error('session_not_found'))).toBe(true);
    expect(state.getResumeId()).toBeNull();
    expect(onExpired).toHaveBeenCalledWith('abc-123');
  });

  it('does not notify onExpired when there is no captured session', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });

    state.handleResumeError(new Error('session not found'));
    expect(onExpired).not.toHaveBeenCalled();
  });
});
