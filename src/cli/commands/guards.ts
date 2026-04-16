import { readActive, isSessionLive, clearActive } from '../../core/sessions/active.js';

export function guardNoActiveSession(projectDir: string): void {
  const active = readActive(projectDir);
  if (!active) return;

  if (isSessionLive(projectDir, active)) {
    // Session exists with a non-terminal phase — could be genuinely running
    // or stale from a crash/kill. Since we can't detect running processes,
    // clear it and let the user start fresh. The old session remains on disk
    // and can be resumed via `diptych resume --session <id>`.
    console.log(`Clearing stale session: ${active} (use 'diptych resume' to continue it instead)`);
    clearActive(projectDir);
  }
}
