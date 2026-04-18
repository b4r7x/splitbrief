import { readActive, isSessionLive, clearActive } from './lifecycle.js';
import { cliError } from '../../cli/errors.js';

export function clearStaleSession(projectDir: string): void {
  const active = readActive(projectDir);
  if (!active) return;

  if (isSessionLive(projectDir, active)) {
    throw cliError(
      `session '${active}' is still active.\nUse 'diptych resume' to continue it, or delete .diptych/active to discard it.`,
    );
  }

  clearActive(projectDir);
}
