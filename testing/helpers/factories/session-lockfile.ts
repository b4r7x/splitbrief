import type { LockfileData } from '../../../src/core/sessions/lockfile-status.js';
import { currentProcessStartTimeMs } from '../../../src/lib/process/start-time.js';

export function makeSessionLockfile(
  sessionId: string,
  overrides: Partial<LockfileData> = {},
): LockfileData {
  return {
    version: 1,
    pid: process.pid,
    startTimeMs: currentProcessStartTimeMs(),
    lastAliveMs: Date.now(),
    sessionId,
    mode: 'standard',
    feature: 'feature',
    ...overrides,
  };
}
