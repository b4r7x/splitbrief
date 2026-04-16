import { readActive, isSessionLive, clearActive } from '../../core/sessions/active.js';
import { cliError } from '../errors.js';

export function clearStaleActiveSessionOrThrow(projectDir: string): void {
  const active = readActive(projectDir);
  if (!active) return;

  if (isSessionLive(projectDir, active)) {
    throw cliError(
      `Error: session '${active}' is still active.\nUse 'diptych resume' to continue it, or delete .diptych/active to discard it.`,
    );
  }

  clearActive(projectDir);
}
