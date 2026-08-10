import { clearActive, clearActiveReceipt, isSessionLive, readActiveRecord } from './lifecycle.js';
import { sessionError } from './errors.js';

export function clearStaleSession(projectDir: string): void {
  const active = readActiveRecord(projectDir);
  if (active === null) return;
  const sessionId = active.kind === 'legacy' ? active.sessionId : active.receipt.sessionId;
  const ref = { projectDir, sessionId };

  if (isSessionLive(ref)) {
    throw sessionError.stillActive(sessionId);
  }

  if (active.kind === 'legacy') clearActive(ref);
  else clearActiveReceipt(ref, active.receipt);
}

// A stale active pointer is what `splitbrief resume` resumes from. Surfaces
// that merely open (home, setup) must reject a live session without clearing
// a stale one; only flows that start a new run may clear it.
export function assertNoLiveSession(projectDir: string): void {
  const active = readActiveRecord(projectDir);
  if (active === null) return;
  const sessionId = active.kind === 'legacy' ? active.sessionId : active.receipt.sessionId;
  if (isSessionLive({ projectDir, sessionId })) {
    throw sessionError.stillActive(sessionId);
  }
}
