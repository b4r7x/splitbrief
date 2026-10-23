import { fileErrorReason, fileFailure, toErrorMessage } from '../../utils/format-errors.js';
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

/** `<what>: <cause> · <project-relative file>`. */
export function sessionFileFailure(what: string, relativePath: string, cause: unknown): string {
  return `${what}: ${fileFailure(fileErrorReason(cause) ?? toErrorMessage(cause), relativePath)}`;
}

// A run file, or the run state `state-ops.ts` saves, that did not reach the disk or was not confirmed there.
const localSaveFailures = [
  matches('session-file-not-saved'),
  matches('state-not-saved'),
  matches('state-durability-uncertain'),
  matches('state-changed-on-disk'),
  matches('state-conflict'),
  matches('state-conflict-exhausted'),
];

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
  draftNotSaved: (relativePath: string, cause: unknown) =>
    error(
      'session-draft-not-saved',
      sessionFileFailure('Draft not saved', relativePath, cause),
      { relativePath },
      cause,
    ),
  summaryNotSaved: (relativePath: string, cause: unknown) =>
    error(
      'session-summary-not-saved',
      sessionFileFailure('Could not save the run summary', relativePath, cause),
      { relativePath },
      cause,
    ),
  fileNotSaved: (relativePath: string, cause: unknown) =>
    error(
      'session-file-not-saved',
      sessionFileFailure('Could not save a run file', relativePath, cause),
      { relativePath },
      cause,
    ),
  draftNotRemoved: (relativePath: string, cause: unknown) =>
    error(
      'session-draft-not-removed',
      `${sessionFileFailure('Could not remove the old draft', relativePath, cause)}${SOFT_SEP}its text comes back when you restart SPLITBRIEF and open that run`,
      { relativePath },
      cause,
    ),

  isStillActive: matches('session-still-active'),
  isSummaryNotSaved: matches('session-summary-not-saved'),
  /** A save SPLITBRIEF could not make in the run's folder is never a seat failing: the run fails with it. */
  isLocalSaveFailure: (err: unknown): boolean => localSaveFailures.some((isKind) => isKind(err)),
  isDraftNotRemoved: matches('session-draft-not-removed'),
} as const;
