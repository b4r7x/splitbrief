import { readActive, isSessionLive, clearActive } from './lifecycle.js';
import { sessionError } from './errors.js';

export function clearStaleSession(projectDir: string): void {
  const active = readActive(projectDir);
  if (!active) return;

  if (isSessionLive({ projectDir, sessionId: active })) {
    throw sessionError.stillActive(active);
  }

  clearActive(projectDir);
}
