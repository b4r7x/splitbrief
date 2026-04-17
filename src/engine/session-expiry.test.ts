import { describe, it, expect, vi } from 'vitest';
import {
  SESSION_EXPIRED_PATTERNS,
  isSessionExpiredError,
  createSessionResumeState,
} from './session-expiry.js';

describe('SESSION_EXPIRED_PATTERNS', () => {
  it('exports all expected regex variants', () => {
    expect(SESSION_EXPIRED_PATTERNS.length).toBe(6);
    expect(SESSION_EXPIRED_PATTERNS.every(p => p instanceof RegExp)).toBe(true);
  });
});

describe('isSessionExpiredError', () => {
  it('matches "session not found"', () => {
    expect(isSessionExpiredError(new Error('Error: session not found'))).toBe(true);
  });

  it('matches "session_not_found"', () => {
    expect(isSessionExpiredError(new Error('API error: session_not_found'))).toBe(true);
  });

  it('matches "invalid session"', () => {
    expect(isSessionExpiredError(new Error('invalid session ID provided'))).toBe(true);
  });

  it('matches "expired session"', () => {
    expect(isSessionExpiredError(new Error('Expired session: abc-123'))).toBe(true);
  });

  it('matches "no such session"', () => {
    expect(isSessionExpiredError(new Error('server returned: no such session'))).toBe(true);
  });

  it('matches "could not resume"', () => {
    expect(isSessionExpiredError(new Error('could not resume: stream closed'))).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isSessionExpiredError(new Error('SESSION NOT FOUND'))).toBe(true);
    expect(isSessionExpiredError(new Error('Invalid Session'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isSessionExpiredError(new Error('network timeout'))).toBe(false);
    expect(isSessionExpiredError(new Error('rate limit exceeded'))).toBe(false);
  });

  it('handles string errors', () => {
    expect(isSessionExpiredError('session not found')).toBe(true);
    expect(isSessionExpiredError('nothing to see here')).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(isSessionExpiredError(null)).toBe(false);
    expect(isSessionExpiredError(undefined)).toBe(false);
  });
});

describe('createSessionResumeState', () => {
  it('starts with null session id', () => {
    const state = createSessionResumeState();
    expect(state.getResumeId()).toBeNull();
  });

  it('captures and returns session id', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');
    expect(state.getResumeId()).toBe('abc-123');
  });

  it('captures null to clear session', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');
    state.capture(null);
    expect(state.getResumeId()).toBeNull();
  });

  it('handleResumeError returns false when no session id', () => {
    const state = createSessionResumeState();
    const result = state.handleResumeError(new Error('session not found'));
    expect(result).toBe(false);
  });

  it('handleResumeError returns false for non-session errors', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');
    const result = state.handleResumeError(new Error('network failed'));
    expect(result).toBe(false);
    expect(state.getResumeId()).toBe('abc-123');
  });

  it('handleResumeError returns true and clears session on session error', () => {
    const state = createSessionResumeState();
    state.capture('abc-123');
    const result = state.handleResumeError(new Error('session not found'));
    expect(result).toBe(true);
    expect(state.getResumeId()).toBeNull();
  });

  it('handleResumeError notifies callback with expired id', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });
    state.capture('abc-123');
    state.handleResumeError(new Error('session_not_found'));
    expect(onExpired).toHaveBeenCalledWith('abc-123');
  });

  it('handleResumeError does not notify when no session', () => {
    const onExpired = vi.fn();
    const state = createSessionResumeState({ onExpired });
    state.handleResumeError(new Error('session not found'));
    expect(onExpired).not.toHaveBeenCalled();
  });
});
