import { updateHeartbeat } from '../../../core/sessions/lockfile.js';
import { HEARTBEAT_STALENESS_MS } from '../../../core/sessions/lockfile-status.js';

// Four pings inside the staleness window: three can be lost before a live session reads stale.
export const LOCKFILE_PING_INTERVAL_MS = HEARTBEAT_STALENESS_MS / 4;

export function startHeartbeat(sessionDir: string): () => void {
  const timer = setInterval(() => {
    void updateHeartbeat(sessionDir);
  }, LOCKFILE_PING_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
