import { updateHeartbeat } from './lockfile.js';
import { HEARTBEAT_INTERVAL_MS } from '../constants.js';

export function startHeartbeat(sessionDir: string): () => void {
  const timer = setInterval(() => {
    void updateHeartbeat(sessionDir);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
