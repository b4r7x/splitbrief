import { spawn } from 'node:child_process';
import { recordRunnerPid } from '../../src/core/sessions/runner-pids.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import { readProcessStartTimeMs } from '../../src/lib/process/start-time.js';

/**
 * A detached process in a run's runner ledger: a tool its crashed CLI left running that no
 * watchdog ended, which only the orphan reaper can stop.
 */
export function plantOrphanRunner(ref: SessionRef): number {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  orphan.unref();
  if (orphan.pid === undefined) throw new Error('the orphan runner did not start');
  recordRunnerPid(ref, orphan.pid, readProcessStartTimeMs(orphan.pid));
  return orphan.pid;
}

/** Teardown for a planted orphan the code under test failed to reap. */
export function killOrphanRunner(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The reaper already ended it.
  }
}
