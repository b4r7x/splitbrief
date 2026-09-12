import { error, matches, type AppError } from '../../utils/error.js';
import { SPLITBRIEF_IDENTITY } from '../identity.js';
import type { SessionRef } from '../types/session-ref.js';

export type SessionPreparationOperation =
  | 'allocate-session'
  | 'write-readiness'
  | 'publish-active'
  | 'release-session'
  | 'rollback-session'
  | 'discard-orphan-session';

type SessionPreparationErrorData = Readonly<{
  operation: SessionPreparationOperation;
  sessionId: string;
}>;

export type SessionPreparationIoError = AppError<'session-prepare-io', SessionPreparationErrorData>;

export const sessionPreparationError = {
  io: (
    operation: SessionPreparationOperation,
    ref: SessionRef,
    cause: unknown,
  ): SessionPreparationIoError =>
    error(
      'session-prepare-io',
      `Failed to ${operation.replaceAll('-', ' ')} for session '${ref.sessionId}'`,
      { operation, sessionId: ref.sessionId },
      cause,
    ),
} as const;

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
      `session '${sessionId}' is still active.\nStop it, then run '${SPLITBRIEF_IDENTITY.executable} continue ${sessionId}' — or delete ${SPLITBRIEF_IDENTITY.stateDir}/active to discard it.`,
      { sessionId },
    ),
  invalidId: (sessionId: string) =>
    error('session-invalid-id', 'invalid session id', { sessionId }),

  isStillActive: matches('session-still-active'),
} as const;
