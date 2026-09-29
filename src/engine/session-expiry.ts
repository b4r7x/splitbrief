import { toErrorMessage } from '../utils/format-errors.js';
import { error } from '../utils/error.js';

export const SESSION_EXPIRED_PATTERNS: readonly RegExp[] = [
  /session not found/i,
  /session_not_found/i,
  /invalid session/i,
  /expired session/i,
  /no such session/i,
  /could not resume/i,
  /session:\s*failed to load/i,
  /thread not loaded/i,
  /no rollout found for thread id/i,
  /no conversation found with session id/i,
];

export function isSessionExpiredError(err: unknown): boolean {
  const msg = toErrorMessage(err);
  return SESSION_EXPIRED_PATTERNS.some((p) => p.test(msg));
}

export interface SessionResumeState {
  getResumeId(): string | null;
  capture(id: string | null): void;
}

export function createSessionResumeState(): SessionResumeState {
  let currentSessionId: string | null = null;

  return {
    getResumeId(): string | null {
      return currentSessionId;
    },
    capture(id: string | null): void {
      currentSessionId = id;
    },
  };
}

export function sessionResumeMismatchError(expectedId: string, actualId: string) {
  return error(
    'session-resume-mismatch',
    `could not resume session ${expectedId}: returned thread id ${actualId}`,
    {
      expectedId,
      actualId,
    },
  );
}

export function sessionResumeExpiredError(sessionId: string, message: string) {
  return error('session-resume-expired', `could not resume session ${sessionId}: ${message}`, {
    sessionId,
  });
}
