import { readActive, isSessionLive } from '../../core/sessions/active.js';
import { cliError } from '../errors.js';

export function guardNoActiveSession(projectDir: string): void {
  const active = readActive(projectDir);
  if (active && isSessionLive(projectDir, active)) {
    throw cliError(`Workflow already running: ${active}. Run 'diptych resume' to continue, or delete .diptych/active after verifying the session is truly stopped.`);
  }
}
