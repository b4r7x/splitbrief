import { updateHeartbeat } from './lockfile.js';

export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALENESS_MS = 8000;

export function startHeartbeat(sessionDir: string): () => void {
  const timer = setInterval(() => {
    void updateHeartbeat(sessionDir);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
