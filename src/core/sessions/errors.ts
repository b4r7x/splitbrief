import { error, matches } from '../../utils/error.js';

export const sessionError = {
  invalidData: (sessionId: string, reason: string) =>
    error('session-invalid-data', `Invalid session data: ${reason}`, { sessionId, reason }),
  idCollision: (base: string, attempts: number) =>
    error(
      'session-id-collision',
      `Could not generate unique session-id from base '${base}': all suffixes up to ${attempts} are taken`,
      { base, attempts },
    ),
  idMismatch: (requestedId: string, sessionId: string) =>
    error(
      'session-id-mismatch',
      `Cannot save session summary for '${requestedId}': session payload id is '${sessionId}'`,
      { requestedId, sessionId },
    ),
  stillActive: (sessionId: string) =>
    error(
      'session-still-active',
      `session '${sessionId}' is still active.\nUse 'splitbrief continue' to attach or resume it (or 'splitbrief attach' if it is running), or delete .splitbrief/active to discard it.`,
      { sessionId },
    ),
  invalidId: (sessionId: string) =>
    error('session-invalid-id', 'invalid session id', { sessionId }),

  isStillActive: matches('session-still-active'),
} as const;
