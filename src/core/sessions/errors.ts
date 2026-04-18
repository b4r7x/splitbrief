import { error, matches } from '../../utils/error.js';

export const sessionError = {
  invalidData: (sessionId: string, reason: string) =>
    error(
      'session-invalid-data',
      `Invalid session data: ${reason}`,
      { sessionId, reason },
    ),
  idCollision: (base: string, attempts: number) =>
    error(
      'session-id-collision',
      `Could not generate unique session-id from base '${base}': all suffixes up to ${attempts} are taken`,
      { base, attempts },
    ),

  isInvalidData: matches('session-invalid-data'),
  isIdCollision: matches('session-id-collision'),
} as const;
