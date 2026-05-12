import { readActive } from '../core/sessions/lifecycle.js';
import { cliError } from './errors.js';

export function resolveSessionOrThrow(projectDir: string, sessionOpt: string | undefined): string {
  const sessionId = sessionOpt ?? readActive(projectDir);
  if (!sessionId) throw cliError('No active session. Pass --session <id>.', 1);
  return sessionId;
}
