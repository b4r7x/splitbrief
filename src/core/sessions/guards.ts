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
