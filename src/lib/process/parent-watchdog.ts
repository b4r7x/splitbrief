import { spawn, type ChildProcess } from 'node:child_process';
import { warnError } from '../warn.js';
import { SIGKILL_DELAY_MS } from './termination.js';

const watchedGroups = new Set<number>();
let parentWatchdog: ChildProcess | null = null;

// A tool group runs in a session of its own, so nothing ends it when SPLITBRIEF dies. This detached
// node process holds an IPC channel to SPLITBRIEF that the kernel closes on any death, SIGKILL
// included; it then ends every group still registered, the way terminateProcess does.
const PARENT_WATCHDOG_SCRIPT = `const groups = new Set();
process.on('message', ({ pid, watch }) => {
  if (watch) groups.add(pid);
  else groups.delete(pid);
});
process.on('disconnect', () => {
  const signalGroups = (signal) => {
    for (const pid of groups) {
      try {
        process.kill(-pid, signal);
      } catch {}
    }
  };
  signalGroups('SIGTERM');
  if (groups.size > 0) setTimeout(() => signalGroups('SIGKILL'), ${SIGKILL_DELAY_MS});
});
`;

function startParentWatchdog(): ChildProcess {
  const watchdog = spawn(process.execPath, ['-e', PARENT_WATCHDOG_SCRIPT], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const forget = () => {
    if (parentWatchdog === watchdog) parentWatchdog = null;
  };
  watchdog.on('disconnect', forget);
  watchdog.on('error', (err) => {
    forget();
    warnError(
      'Could not start the helper that stops tool processes if SPLITBRIEF exits early, so they may keep running',
      err,
    );
  });
  watchdog.unref();
  watchdog.channel?.unref();
  for (const pid of watchedGroups) watchdog.send({ pid, watch: true });
  return watchdog;
}

export function watchGroup(pid: number): void {
  watchedGroups.add(pid);
  if (parentWatchdog === null) parentWatchdog = startParentWatchdog();
  else parentWatchdog.send({ pid, watch: true });
}

export function unwatchGroup(pid: number): void {
  watchedGroups.delete(pid);
  parentWatchdog?.send({ pid, watch: false });
}
