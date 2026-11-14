import { STATE_FILE } from '../../../core/paths.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { sessionFileFailure } from '../../../core/sessions/errors.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
import type { ConfigRevision } from '../../../lib/fs/atomic-write/types.js';
import { type AppError, error, matches } from '../../../utils/error.js';
import type { WorkflowPersistenceContext } from '../types.js';

export const MAX_STATE_CONFLICT_RETRIES = 3;
export const DEFAULT_STATE_CONFLICT_RETRIES = 1;

export type StateOperationExpectedRevision = number | ConfigRevision | null;

export type StateMutationOptions = Readonly<{
  expectedRevision?: StateOperationExpectedRevision | undefined;
  conflictRetries?: number | undefined;
}>;

export type StateOperationContext = WorkflowPersistenceContext &
  Readonly<{
    expectedRevision?: StateOperationExpectedRevision | undefined;
    conflictRetries?: number | undefined;
  }>;

export type StateOperationConflictData = Readonly<{
  operation: 'transition' | 'queue' | 'usage';
  expectedRevision: number | null;
  observedRevision: number | null;
  attempts: number;
  retryLimit: number;
}>;

export type StateOperationConflictError = AppError<
  'state-conflict' | 'state-conflict-exhausted',
  StateOperationConflictData
>;

export const stateOpsError = {
  conflict: (sessionId: string, data: StateOperationConflictData): StateOperationConflictError =>
    error(
      'state-conflict',
      `Another process changed the run state, so this change was not saved${SOFT_SEP}${sessionRelativePath(sessionId, STATE_FILE)}`,
      data,
    ),
  conflictExhausted: (
    sessionId: string,
    data: StateOperationConflictData,
  ): StateOperationConflictError =>
    error(
      'state-conflict-exhausted',
      `Another process kept changing the run state, so this change was not saved${SOFT_SEP}${sessionRelativePath(sessionId, STATE_FILE)}`,
      data,
    ),
  invalidHead: (message: string, cause?: unknown) =>
    error('state-head-invalid', message, undefined, cause),
  isInvalidHead: matches('state-head-invalid'),
  notSaved: (sessionId: string, cause: unknown) =>
    error(
      'state-not-saved',
      sessionFileFailure(
        'Could not save the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        cause,
      ),
      undefined,
      cause,
    ),
  durabilityUncertain: (sessionId: string) =>
    error(
      'state-durability-uncertain',
      `Saved the run state, but could not confirm it on disk${SOFT_SEP}${sessionRelativePath(sessionId, STATE_FILE)}`,
    ),
  notRead: (sessionId: string, cause: unknown) =>
    error(
      'state-head-invalid',
      sessionFileFailure(
        'Could not read the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        cause,
      ),
      undefined,
      cause,
    ),
  changedOnDisk: (sessionId: string) =>
    error(
      'state-changed-on-disk',
      sessionFileFailure(
        'Could not save the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        'the file changed on disk before SPLITBRIEF could save it',
      ),
    ),
} as const;
