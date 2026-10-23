import { isNodeError } from '../../lib/process/errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { error, matches, type AppError } from '../../utils/error.js';
import { SPLITBRIEF_IDENTITY } from '../identity.js';
import { SOFT_SEP } from '../separators.js';
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

/** What works on a run another process still runs: stop it there, then continue it. */
export function stillActiveFix(sessionId: string): string {
  return `Stop it, then run '${SPLITBRIEF_IDENTITY.executable} continue ${sessionId}' — or delete ${SPLITBRIEF_IDENTITY.stateDir}/active to discard it.`;
}

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
      `session '${sessionId}' is still active.\n${stillActiveFix(sessionId)}`,
      { sessionId },
    ),
  invalidId: (sessionId: string) =>
    error('session-invalid-id', 'invalid session id', { sessionId }),
  // Node spells a file error `EACCES: permission denied, open '<absolute path>'`: the user needs
  // only its words and the project-relative file.
  draftNotSaved: (relativePath: string, cause: unknown) => {
    const reason =
      (isNodeError(cause) && /^E[A-Z]+: ([^,]+)/.exec(cause.message)?.[1]) || toErrorMessage(cause);
    return error(
      'session-draft-not-saved',
      `Draft not saved: ${reason}${SOFT_SEP}${relativePath}`,
      { relativePath, reason },
      cause,
    );
  },

  isStillActive: matches('session-still-active'),
} as const;
