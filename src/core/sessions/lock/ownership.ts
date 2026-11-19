import { join } from 'node:path';
import { tryClaimDatabaseLock } from '../../../lib/fs/ownership-lock.js';
import { SPLITBRIEF_DIR, validateSessionId } from '../../paths.js';
import type { SessionRef } from '../../types/session-ref.js';

export function sessionClaimPath(sessionId: string): string {
  validateSessionId(sessionId);
  return join(SPLITBRIEF_DIR, 'session-locks', sessionId);
}

/** Serializes driver and cleanup operations for one session, including across processes. */
export function tryClaimSession(ref: SessionRef): (() => void) | null {
  return tryClaimDatabaseLock(ref.projectDir, sessionClaimPath(ref.sessionId));
}
